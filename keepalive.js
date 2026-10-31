"use strict";

/**
 * keepalive.js — Render free-tier keep-alive.
 *
 * A Render free *web service* spins down (the dashboard shows it as
 * "suspended"/"stopped") after 15 minutes without an inbound HTTP request.
 * Outbound traffic from the bot (Minecraft socket, Discord webhooks) does NOT
 * reset that timer, so a bot that is happily connected to a Minecraft server
 * can still be put to sleep.
 *
 * This module periodically sends a real HTTP request to the service's own
 * public URL, which is what resets Render's 15-minute idle timer.
 *
 * Important rules baked in here:
 *   - Never ping localhost/127.0.0.1 — Render's router is bypassed and the
 *     idle timer is NOT reset.
 *   - Never ping /robots.txt — Render answers that path itself while the
 *     service is asleep, so it never wakes (and never counts as traffic).
 *   - Never wait 15+ minutes between pings; the effective interval is clamped
 *     to 60s .. 14min.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // must stay well under 15 min
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 14 * 60 * 1000 - 5000;
const PING_TIMEOUT_MS = 60 * 1000; // cold start on free tier can take ~1 min
const RETRY_DELAY_MS = 20 * 1000;
const MAX_REDIRECTS = 3;

const PING_PATH = "/ping";

function clampInterval(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, value));
}

function normalizeTarget(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return { url: null, reason: "no-url" };

  let raw = rawUrl.trim();
  if (!raw) return { url: null, reason: "no-url" };
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (err) {
    return { url: null, reason: `invalid-url: ${err.message}` };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local")
  ) {
    return {
      url: null,
      reason:
        "localhost-url — a loopback request never leaves the container, so Render's idle timer is not reset",
    };
  }

  // "/" and "/robots.txt" are intercepted by Render while a service is asleep.
  if (!parsed.pathname || parsed.pathname === "/" || parsed.pathname === "/robots.txt") {
    parsed.pathname = PING_PATH;
  }
  parsed.hash = "";
  return { url: parsed.toString(), reason: null };
}

function pickTarget() {
  const env = process.env;
  const candidates = [
    ["KEEP_ALIVE_URL", env.KEEP_ALIVE_URL],
    ["SELF_PING_URL", env.SELF_PING_URL],
    ["PUBLIC_URL", env.PUBLIC_URL],
    ["RENDER_EXTERNAL_URL", env.RENDER_EXTERNAL_URL],
    [
      "RENDER_EXTERNAL_HOSTNAME",
      env.RENDER_EXTERNAL_HOSTNAME ? `https://${env.RENDER_EXTERNAL_HOSTNAME}` : "",
    ],
  ];

  const reasons = [];
  for (const [name, value] of candidates) {
    if (!value) continue;
    const result = normalizeTarget(value);
    if (result.url) return { url: result.url, source: name, reason: null };
    reasons.push(`${name}: ${result.reason}`);
  }

  return {
    url: null,
    source: null,
    reason: reasons.length
      ? reasons.join("; ")
      : "no KEEP_ALIVE_URL / RENDER_EXTERNAL_URL / RENDER_EXTERNAL_HOSTNAME set",
  };
}

function requestOnce(urlString, redirectsLeft) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (err) {
      return resolve({ ok: false, status: null, error: `bad-url: ${err.message}` });
    }

    const lib = parsed.protocol === "http:" ? http : https;
    const startedAt = Date.now();

    const req = lib.get(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          "User-Agent": "minecraft-afk-bot keepalive",
          "Cache-Control": "no-cache",
          Connection: "close",
        },
        timeout: PING_TIMEOUT_MS,
      },
      (res) => {
        // Follow one or two redirects (e.g. http -> https, custom domain).
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          res.resume();
          const next = new URL(res.headers.location, urlString).toString();
          return requestOnce(next, redirectsLeft - 1).then(resolve);
        }

        res.resume(); // drain the body so the socket can be released
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            latencyMs: Date.now() - startedAt,
            error: null,
            finalUrl: urlString,
          }),
        );
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${PING_TIMEOUT_MS / 1000}s`));
    });

    req.on("error", (err) => {
      resolve({ ok: false, status: null, error: err.message, latencyMs: Date.now() - startedAt });
    });
  });
}

/**
 * @param {{ log?: (msg: string) => void, intervalMs?: number }} options
 */
function createKeepAlive(options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const env = process.env;

  const state = {
    enabled: false,
    target: null,
    source: null,
    intervalMs: null,
    startedAt: null,
    nextPingAt: null,
    lastPingAt: null,
    lastStatus: null,
    lastLatencyMs: null,
    lastError: null,
    consecutiveFailures: 0,
    totalPings: 0,
    totalFailures: 0,
    disabledReason: null,
  };

  let timer = null;
  let inFlight = false;

  function schedule(delayMs) {
    if (!state.enabled) return;
    state.nextPingAt = Date.now() + delayMs;
    timer = setTimeout(tick, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function tick() {
    if (!state.enabled) return;

    if (inFlight) {
      log("[KeepAlive] Previous ping still running — skipping this round");
      schedule(state.intervalMs);
      return;
    }

    inFlight = true;
    const result = await requestOnce(state.target, MAX_REDIRECTS);
    inFlight = false;

    state.lastPingAt = Date.now();
    state.lastStatus = result.status;
    state.lastLatencyMs = result.latencyMs ?? null;
    state.totalPings += 1;

    if (result.ok) {
      state.consecutiveFailures = 0;
      state.lastError = null;
      log(`[KeepAlive] Ping OK (${result.status}) in ${result.latencyMs}ms — idle timer reset`);
      schedule(state.intervalMs);
    } else {
      state.consecutiveFailures += 1;
      state.totalFailures += 1;
      state.lastError = result.error || `HTTP ${result.status}`;
      log(
        `[KeepAlive] Ping FAILED (${state.lastError}) — retrying in ${RETRY_DELAY_MS / 1000}s`,
      );
      schedule(Math.min(RETRY_DELAY_MS, state.intervalMs));
    }
  }

  function start() {
    if (state.enabled) return state;

    if (env.KEEP_ALIVE === "0" || env.KEEP_ALIVE === "false" || env.KEEP_ALIVE === "off") {
      state.disabledReason = "KEEP_ALIVE is disabled via env var";
      log(`[KeepAlive] Disabled — ${state.disabledReason}`);
      return state;
    }

    const target = pickTarget();
    if (!target.url) {
      state.disabledReason = target.reason;
      log(`[KeepAlive] Self-ping disabled — ${target.reason}`);
      return state;
    }

    state.enabled = true;
    state.target = target.url;
    state.source = target.source;
    state.intervalMs = clampInterval(
      Number(env.KEEP_ALIVE_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
    );
    state.startedAt = Date.now();

    log(
      `[KeepAlive] Self-ping every ${(state.intervalMs / 60000).toFixed(1)} min -> ${state.target} (from ${state.source})`,
    );
    // First ping shortly after boot so a fresh deploy is marked awake quickly.
    schedule(20 * 1000);
    return state;
  }

  function stop() {
    state.enabled = false;
    state.disabledReason = "stopped";
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function stats() {
    return {
      ...state,
      nextPingInSec:
        state.enabled && state.nextPingAt
          ? Math.max(0, Math.round((state.nextPingAt - Date.now()) / 1000))
          : null,
    };
  }

  return { start, stop, stats, pingNow: () => requestOnce(state.target, MAX_REDIRECTS) };
}

module.exports = {
  createKeepAlive,
  normalizeTarget,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  PING_PATH,
};
