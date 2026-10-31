"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const pkg = require("./package.json");
const { createKeepAlive } = require("./keepalive");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// ENV OVERRIDES
// Render env vars win over settings.json, so you can change the
// target server / account from the dashboard without redeploying code.
// ============================================================
function applyEnvOverrides(cfg) {
  const env = process.env;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  cfg.server = cfg.server || {};
  cfg["bot-account"] = cfg["bot-account"] || {};
  cfg.utils = cfg.utils || {};

  if (env.MC_HOST) cfg.server.ip = env.MC_HOST;
  const port = num(env.MC_PORT);
  if (port) cfg.server.port = port;
  if (env.MC_VERSION) cfg.server.version = env.MC_VERSION;
  if (env.MC_USERNAME) cfg["bot-account"].username = env.MC_USERNAME;
  if (env.MC_AUTH) cfg["bot-account"].type = env.MC_AUTH;
  if (env.MC_PASSWORD) cfg["bot-account"].password = env.MC_PASSWORD;

  if (env.AUTH_PASSWORD) {
    cfg.utils["auto-auth"] = cfg.utils["auto-auth"] || { enabled: true };
    cfg.utils["auto-auth"].password = env.AUTH_PASSWORD;
  }

  return cfg;
}

applyEnvOverrides(config);

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// Keep-alive (self-ping) — prevents Render's 15 minute free-tier idle spin-down.
// Started after the HTTP server is listening; inspected by GET /diag.
const keepAlive = createKeepAlive({ log: addLog });

// Render free instances have 512 MB RAM. Restart ourselves before the OOM
// killer does, because a hard OOM looks exactly like "the service died".
const MEMORY_LIMIT_MB = Number(process.env.MEMORY_LIMIT_MB) || 460;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

// Health check endpoint for monitoring
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 24px;
          }

          main { width: 100%; max-width: 400px; }

          header { margin-bottom: 28px; }
          header h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          header p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
            line-height: 1.5;
          }

          .status-section {
            border-radius: 12px;
            padding: 20px 24px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 16px;
            transition: background 0.3s, border-color 0.3s;
          }
          .status-section.online  { background: #0d2218; border: 2px solid #238636; }
          .status-section.offline { background: #200d0d; border: 2px solid #da3633; }

          .status-icon {
            width: 44px; height: 44px;
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 20px; flex-shrink: 0;
            transition: background 0.3s;
          }
          .status-icon.online  { background: #238636; }
          .status-icon.offline { background: #da3633; }

          .status-label { font-size: 18px; font-weight: 700; line-height: 1.2; transition: color 0.3s; }
          .status-label.online  { color: #3fb950; }
          .status-label.offline { color: #f85149; }
          .status-detail { font-size: 13px; color: #8b949e; margin-top: 3px; }

          dl { margin: 0; }
          .stat-card {
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 10px;
            padding: 16px 20px;
            margin-bottom: 10px;
          }
          dt { font-size: 12px; color: #8b949e; font-weight: 600; margin-bottom: 4px; }
          dd { margin: 0; font-size: 17px; font-weight: 600; color: #e6edf3; line-height: 1.3; }
          .stat-detail { margin: 4px 0 0; font-size: 11px; color: #6e7681; }

          .controls { margin-top: 8px; }
          .btn-grid { display: grid; gap: 10px; margin-bottom: 10px; }
          .btn-grid-2 { grid-template-columns: 1fr 1fr; }

          .btn-primary {
            min-height: 52px; border-radius: 10px;
            font-size: 15px; font-weight: 700;
            cursor: pointer; letter-spacing: 0.3px;
            transition: opacity 0.2s, filter 0.2s;
            font-family: inherit;
          }
          .btn-primary:hover  { filter: brightness(1.1); }
          .btn-primary:active { opacity: 0.85; }
          .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
          .btn-stop  { border: 2px solid #da3633; background: #200d0d; color: #f85149; }

          .btn-secondary {
            min-height: 44px; border-radius: 10px;
            border: 1px solid #21262d; background: #161b22; color: #8b949e;
            font-size: 13px; font-weight: 500;
            text-decoration: none;
            display: flex; align-items: center; justify-content: center;
            font-family: inherit; cursor: pointer;
            transition: background 0.2s, color 0.2s;
          }
          .btn-secondary:hover { background: #21262d; color: #c9d1d9; }

          footer { margin-top: 20px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main role="main" aria-label="AFK Bot Dashboard">

          <header>
            <h1>AFK Bot Dashboard</h1>
            <p>Minecraft server bot &middot; Live status</p>
          </header>

          <section
            id="status-section"
            role="status"
            aria-live="polite"
            aria-label="Bot connection status"
            class="status-section offline"
          >
            <div id="status-icon" aria-hidden="true" class="status-icon offline">&#x2717;</div>
            <div>
              <div id="status-label" class="status-label offline">Connecting…</div>
              <div id="status-detail" class="status-detail">Establishing connection</div>
            </div>
          </section>

          <section aria-label="Bot statistics">
            <dl>
              <div class="stat-card">
                <dt>Uptime</dt>
                <dd id="uptime-text">—</dd>
                <p class="stat-detail">Time since last connection</p>
              </div>
              <div class="stat-card">
                <dt>Coordinates</dt>
                <dd id="coords-text">Searching…</dd>
                <p class="stat-detail">Bot's current in-game position</p>
              </div>
              <div class="stat-card">
                <dt>Server address</dt>
                <dd>${config.server.ip}</dd>
                <p class="stat-detail">Minecraft server hostname</p>
              </div>
              <div class="stat-card">
                <dt>Keep-alive</dt>
                <dd id="keepalive-text">—</dd>
                <p class="stat-detail">Self-ping that stops Render from sleeping</p>
              </div>
            </dl>
          </section>

          <section class="controls" aria-label="Bot controls">
            <div class="btn-grid btn-grid-2">
              <button class="btn-primary btn-start" onclick="startBot()" aria-label="Start bot">Start bot</button>
              <button class="btn-primary btn-stop" onclick="stopBot()" aria-label="Stop bot">Stop bot</button>
            </div>
            <div class="btn-grid btn-grid-2">
              <a href="/tutorial" class="btn-secondary" aria-label="View setup guide">Setup guide</a>
              <a href="/logs" class="btn-secondary" aria-label="View bot logs">View logs</a>
            </div>
            <div class="btn-grid">
              <a href="/diag" class="btn-secondary" aria-label="View diagnostics">Diagnostics</a>
            </div>
          </section>

          <footer>
            <p>Status updates every 5 seconds</p>
          </footer>

        </main>

        <script>
          function formatUptime(s) {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
            if (m > 0) return m + 'm ' + sec + 's';
            return sec + ' seconds';
          }

          async function update() {
            try {
              const r = await fetch('/health');
              const data = await r.json();
              const online = data.status === 'connected';

              const section = document.getElementById('status-section');
              const icon    = document.getElementById('status-icon');
              const label   = document.getElementById('status-label');
              const detail  = document.getElementById('status-detail');

              section.className = 'status-section ' + (online ? 'online' : 'offline');
              icon.className    = 'status-icon '    + (online ? 'online' : 'offline');
              icon.textContent  = online ? '✓' : '✗';
              label.className   = 'status-label '   + (online ? 'online' : 'offline');
              label.textContent = online ? 'Connected' : 'Disconnected';
              detail.textContent = online ? 'Bot is active on the server' : 'Attempting to reconnect';

              document.getElementById('uptime-text').textContent = formatUptime(data.uptime);

              if (data.coords) {
                const x = Math.floor(data.coords.x);
                const y = Math.floor(data.coords.y);
                const z = Math.floor(data.coords.z);
                document.getElementById('coords-text').textContent = 'X ' + x + ', Y ' + y + ', Z ' + z;
              } else {
                document.getElementById('coords-text').textContent = 'Searching…';
              }

              const ka = data.keepAlive || {};
              const kaEl = document.getElementById('keepalive-text');
              if (kaEl) {
                if (!ka.enabled) {
                  kaEl.textContent = 'Off';
                  kaEl.style.color = '#e3b341';
                } else if (ka.consecutiveFailures > 0) {
                  kaEl.textContent = 'Failing (' + ka.consecutiveFailures + ')';
                  kaEl.style.color = '#f85149';
                } else if (ka.lastPingAt) {
                  const ago = Math.round((Date.now() - ka.lastPingAt) / 1000);
                  kaEl.textContent = 'OK' + (ka.lastStatus ? ' (' + ka.lastStatus + ')' : '') +
                                     ' · ' + (ago < 90 ? ago + 's ago' : Math.round(ago / 60) + 'm ago');
                  kaEl.style.color = '#3fb950';
                } else {
                  kaEl.textContent = 'Warming up…';
                  kaEl.style.color = '#8b949e';
                }
              }
            } catch (e) {
              const label = document.getElementById('status-label');
              label.className = 'status-label offline';
              label.textContent = 'Unreachable';
            }
          }

          async function startBot() {
            const r = await fetch('/start', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot started!' : data.msg);
            update();
          }

          async function stopBot() {
            const r = await fetch('/stop', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot stopped!' : data.msg);
            update();
          }

          setInterval(update, 5000);
          update();
        </script>
      </body>
    </html>
  `);
});

app.get("/tutorial", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Setup Guide</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; background: #0d1117; color: #e6edf3; padding: 40px 24px; }
          main { max-width: 560px; margin: 0 auto; }
          a { color: #58a6ff; }
          .step-card { background: #161b22; border: 1px solid #21262d; border-radius: 12px; padding: 24px; margin-bottom: 16px; }
          code { background: #21262d; padding: 2px 7px; border-radius: 5px; }
        </style>
      </head>
      <body>
        <main>
          <a href="/">&#8592; Back to Dashboard</a>
          <h1>Setup Guide</h1>
          <div class="step-card">
            <h2>1. Configure Aternos</h2>
            <ol>
              <li>Install Paper/Bukkit as server software.</li>
              <li>Enable Cracked mode.</li>
              <li>Install ViaVersion, ViaBackwards, ViaRewind plugins.</li>
            </ol>
          </div>
          <div class="step-card">
            <h2>2. Edit settings.json</h2>
            <p>Set your server IP and port.</p>
          </div>
          <div class="step-card">
            <h2>3. Deploy on Render</h2>
            <ol>
              <li>Push to GitHub.</li>
              <li>Create Web Service on Render.</li>
              <li>Build: <code>npm install</code>, Start: <code>npm start</code>.</li>
            </ol>
          </div>
        </main>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  const ka = keepAlive.stats();
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    keepAlive: {
      enabled: ka.enabled,
      lastStatus: ka.lastStatus,
      lastPingAt: ka.lastPingAt,
      nextPingInSec: ka.nextPingInSec,
      consecutiveFailures: ka.consecutiveFailures,
      disabledReason: ka.disabledReason,
    },
  });
});

// Full diagnostic dump — the first place to look when Render suspends the
// service or the bot keeps dropping. Everything here is read-only.
app.get("/diag", (req, res) => {
  const mem = process.memoryUsage();
  const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  const ka = keepAlive.stats();

  const hints = [];
  if (!process.env.RENDER) {
    hints.push("Not running on Render (RENDER env var missing) — keep-alive only matters in production.");
  }
  if (!process.env.RENDER_EXTERNAL_URL) {
    hints.push(
      "RENDER_EXTERNAL_URL is not set. Render only sets it for Web Services — a Background Worker has no public URL and cannot be kept awake this way.",
    );
  }
  if (!ka.enabled) {
    hints.push(`Self-ping is OFF: ${ka.disabledReason || "unknown reason"}.`);
  }
  if (ka.consecutiveFailures > 0) {
    hints.push(
      `Self-ping failing (${ka.consecutiveFailures} in a row): ${ka.lastError}. Requests are not reaching the service, so Render's idle timer is not being reset.`,
    );
  }
  if (process.env.RENDER && ka.enabled && ka.consecutiveFailures === 0 && ka.totalPings > 0) {
    hints.push("Keep-alive is healthy: idle spin-down should not happen while this process runs.");
  }
  hints.push(
    "If the Render dashboard shows 'Suspended' with a Resume button, that is not idle spin-down — check Dashboard > Billing (750 free instance hours/month) and the Events tab.",
  );

  res.json({
    ok: true,
    app: {
      name: config.name,
      version: pkg.version,
      node: process.version,
      pid: process.pid,
      uptimeSec: Math.floor((Date.now() - botState.startTime) / 1000),
      botRunning,
    },
    server: {
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version,
      username: config["bot-account"].username,
      auth: config["bot-account"].type,
    },
    bot: {
      connected: botState.connected,
      spawned: Boolean(bot && bot.entity),
      position: bot && bot.entity ? bot.entity.position : null,
      reconnectAttempts: botState.reconnectAttempts,
      reconnecting: isReconnecting,
      lastActivity: botState.lastActivity,
      recentErrors: botState.errors.slice(-5),
    },
    keepAlive: ka,
    render: {
      detected: Boolean(process.env.RENDER),
      serviceName: process.env.RENDER_SERVICE_NAME || null,
      serviceId: process.env.RENDER_SERVICE_ID || null,
      instanceType: process.env.RENDER_INSTANCE_TYPE || null,
      region: process.env.RENDER_REGION || null,
      externalUrl: process.env.RENDER_EXTERNAL_URL || null,
    },
    memory: {
      rssMB: mb(mem.rss),
      heapUsedMB: mb(mem.heapUsed),
      heapTotalMB: mb(mem.heapTotal),
      externalMB: mb(mem.external),
      limitMB: MEMORY_LIMIT_MB,
    },
    hints,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/logs", (req, res) => {
  const logs = getLogs();

  const escapeHTML = (str) =>
    str.replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[m],
    );

  const logCount = logs.length;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Logs</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; background: #0d1117; color: #e6edf3; padding: 40px 24px; margin: 0; }
          main { max-width: 760px; margin: 0 auto; }
          a { color: #58a6ff; }
          .log-card { background: #0d1117; border: 1px solid #21262d; border-radius: 12px; overflow: hidden; }
          .log-body { padding: 16px 18px; max-height: 560px; overflow-y: auto; font-family: monospace; font-size: 12.5px; }
          .log-entry { display: block; padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
          .log-entry.error { color: #ff7b72; }
          .log-entry.warn { color: #e3b341; }
          .log-entry.success { color: #3fb950; }
          .log-entry.control { color: #58a6ff; }
          .log-entry.default { color: #8b949e; }
          .console-row { display: flex; border-top: 1px solid #21262d; padding: 10px 18px; gap: 10px; }
          .console-input { flex: 1; background: transparent; border: none; outline: none; color: #e6edf3; font-family: monospace; }
          .console-send { background: #0d2218; border: 1px solid #238636; color: #3fb950; padding: 5px 14px; border-radius: 6px; cursor: pointer; }
        </style>
      </head>
      <body>
        <main>
          <a href="/">&#8592; Back</a>
          <h1>Bot Logs (${logCount})</h1>
          <div class="log-card">
            <div class="log-body" id="log-body">
              ${logCount === 0
                ? `<div style="padding:40px;text-align:center;color:#484f58;">No log entries yet.</div>`
                : logs.map((l) => {
                    const escaped = escapeHTML(l);
                    const lower = l.toLowerCase();
                    let cls = "default";
                    if (lower.includes("error") || lower.includes("fail")) cls = "error";
                    else if (lower.includes("warn")) cls = "warn";
                    else if (lower.includes("[control]")) cls = "control";
                    else if (lower.includes("connect") || lower.includes("join") || lower.includes("spawn")) cls = "success";
                    return `<span class="log-entry ${cls}">${escaped}</span>`;
                  }).join("")
              }
            </div>
            <div class="console-row">
              <span style="color:#3fb950;font-weight:700;">&gt;</span>
              <input id="console-input" class="console-input" type="text" placeholder="Type command or chat..." autocomplete="off">
              <button id="console-send" class="console-send">Send</button>
            </div>
          </div>
        </main>
        <script>
          var input = document.getElementById('console-input');
          var sendBtn = document.getElementById('console-send');
          var logBody = document.getElementById('log-body');

          function sendCommand() {
            var cmd = input.value.trim();
            if (!cmd) return;
            input.value = '';
            fetch('/command', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command: cmd })
            }).then(function(r) { return r.json(); })
              .then(function(data) {
                var span = document.createElement('span');
                span.className = 'log-entry ' + (data.success ? 'control' : 'error');
                span.textContent = '> ' + cmd + ' | ' + (data.msg || '');
                logBody.appendChild(span);
                logBody.scrollTop = logBody.scrollHeight;
              });
          }

          sendBtn.addEventListener('click', sendCommand);
          input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') sendCommand();
          });

          logBody.scrollTop = logBody.scrollHeight;
          setTimeout(function() { location.reload(); }, 5000);
        </script>
      </body>
    </html>
  `);
});

let botRunning = true;

app.post("/start", (req, res) => {
  if (botRunning && bot) return res.json({ success: false, msg: "Already running" });

  botRunning = true;
  createBot();
  addLog("[Control] Bot started");

  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });

  botRunning = false;

  if (bot) {
    try { bot.end(); } catch (e) {}
    bot = null;
  }

  clearAllIntervals();
  addLog("[Control] Bot stopped");

  res.json({ success: true });
});

app.post("/command", express.json(), (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });

  addLog(`[Console] > ${cmd}`);

  if (cmd === "/help") {
    const lines = [
      "Available commands:",
      "  /help          - Show this help message",
      "  /pos           - Show bot's current coordinates",
      "  /status        - Show bot connection status",
      "  /list          - Ask server for player list",
      "  /say <message> - Send a chat message in-game",
    ];
    lines.forEach((l) => addLog(`[Console] ${l}`));
    return res.json({ success: true, msg: lines.join("\n") });
  }

  if (cmd === "/pos" || cmd === "/coords") {
    const pos = bot && bot.entity ? bot.entity.position : null;
    const msg = pos
      ? `Position: X=${Math.floor(pos.x)}  Y=${Math.floor(pos.y)}  Z=${Math.floor(pos.z)}`
      : "Position unavailable (bot not spawned).";
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (cmd === "/status") {
    const status = botState.connected ? "Connected" : "Disconnected";
    const uptime = Math.floor((Date.now() - botState.startTime) / 1000);
    const msg = `Status: ${status} | Uptime: ${uptime}s | Reconnects: ${botState.reconnectAttempts}`;
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (!bot || typeof bot.chat !== "function") {
    const msg = bot
      ? "Bot is still connecting — try again in a moment."
      : "Bot is not running.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: false, msg });
  }

  try {
    bot.chat(cmd);
    addLog(`[Console] Sent to server: ${cmd}`);
    return res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    addLog(`[Console] Error: ${err.message}`);
    return res.json({ success: false, msg: err.message });
  }
});

// ============================================================
//                    END OF WEB TOOLS
// ============================================================

const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server started on port ${server.address().port}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    addLog(`[Server] Port ${PORT} in use — Render will assign a valid port automatically`);
  } else {
    addLog(`[Server] HTTP server error: ${err.message}`);
  }
});

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// ============================================================
// KEEP-ALIVE - stop Render's free-tier 15 min idle spin-down
// ============================================================
// Render puts a free web service to sleep after 15 minutes without inbound
// HTTP traffic. Minecraft/Discord traffic is outbound, so it does not count.
// See keepalive.js for the full rules (no localhost, no /robots.txt, retries).
keepAlive.start();

// ============================================================
// MEMORY MONITORING - free tier has 512 MB, reboot before OOM
// ============================================================
let memoryLogTick = 0;

setInterval(() => {
  const mem = process.memoryUsage();
  const rssMB = mem.rss / 1024 / 1024;
  const heapMB = mem.heapUsed / 1024 / 1024;

  memoryLogTick += 1;
  if (memoryLogTick % 5 === 1) {
    addLog(
      `[Memory] RSS: ${rssMB.toFixed(1)} MB | Heap: ${heapMB.toFixed(1)} MB | Limit: ${MEMORY_LIMIT_MB} MB`,
    );
  }

  if (rssMB > MEMORY_LIMIT_MB) {
    addLog(
      `[Memory] RSS ${rssMB.toFixed(1)} MB is above the ${MEMORY_LIMIT_MB} MB guard — restarting the process before Render OOM-kills it`,
    );
    if (config.discord && config.discord.enabled) {
      sendDiscordWebhook(
        `[!] **Memory guard** — restarting at ${rssMB.toFixed(0)} MB RSS`,
        0xf59e0b,
      );
    }
    botRunning = false;
    keepAlive.stop();
    try {
      if (bot) bot.quit();
    } catch (_) {}
    setTimeout(() => process.exit(1), 2000);
  }
}, 60 * 1000);

// ============================================================
// RECONNECTION & TIMEOUT MANAGEMENT
// ============================================================
let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;

function clearBotTimeouts() {
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  }
}

let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000;

function clearAllIntervals() {
  addLog(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  activeIntervals.forEach((id) => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    const throttleDelay = 60000 + Math.floor(Math.random() * 60000);
    addLog(`[Bot] Throttle detected - using extended delay: ${throttleDelay / 1000}s`);
    return throttleDelay;
  }

  const baseDelay = config.utils["auto-reconnect-delay"] || 3000;
  const maxDelay = config.utils["max-reconnect-delay"] || 30000;
  const delay = Math.min(
    baseDelay * Math.pow(2, botState.reconnectAttempts),
    maxDelay,
  );
  const jitter = Math.floor(Math.random() * 2000);
  return delay + jitter;
}

function createBot() {
  if (!botRunning) {
    addLog("[Bot] Bot is stopped, not creating");
    return;
  }

  if (isReconnecting) {
    addLog("[Bot] Already reconnecting, skipping...");
    return;
  }

  if (bot) {
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      addLog("[Cleanup] Error ending previous bot: " + e.message);
    }
    bot = null;
  }

  addLog(`[Bot] Creating bot instance...`);
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    const botVersion =
      config.server.version && config.server.version.trim() !== ""
        ? config.server.version
        : false;
    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      // Hide raw protocol stack traces in production: they flood Render logs
      // (free tier log storage is limited) while our own handlers still log.
      hideErrors: process.env.MC_DEBUG !== "1",
      checkTimeoutInterval: 600000,
    });

    bot.loadPlugin(pathfinder);

    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Connection timeout - no spawn received");
        try {
          bot.removeAllListeners();
          bot.end();
        } catch (e) {}
        bot = null;
        scheduleReconnect();
      }
    }, 150000);

    let spawnHandled = false;

    bot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;

      clearBotTimeouts();
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;

      addLog(`[Bot] [+] Successfully spawned on server! (Version: ${bot.version})`);
      if (config.discord && config.discord.events && config.discord.events.connect) {
        sendDiscordWebhook(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80);
      }

      const mcData = require("minecraft-data")(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;
      defaultMove.liquidCost = 1000;
      defaultMove.fallDamageCost = 1000;

      initializeModules(bot, mcData, defaultMove);

      setTimeout(() => {
        if (bot && botState.connected && config.server["try-creative"]) {
          bot.chat("/gamemode creative");
          addLog("[INFO] Attempted to set creative mode (requires OP)");
        }
      }, 3000);

      bot.on("messagestr", (message) => {
        if (
          message.includes("commands.gamemode.success.self") ||
          message.includes("Set own game mode to Creative Mode")
        ) {
          addLog("[INFO] Bot is now in Creative Mode.");
        }
      });
    });

    bot.on("kicked", (reason) => {
      const kickReason = typeof reason === "object" ? JSON.stringify(reason) : reason;
      addLog(`[Bot] Kicked: ${kickReason}`);
      botState.connected = false;
      botState.errors.push({ type: "kicked", reason: kickReason, time: Date.now() });
      clearAllIntervals();

      const reasonStr = String(kickReason).toLowerCase();
      if (
        reasonStr.includes("throttl") ||
        reasonStr.includes("wait before reconnect") ||
        reasonStr.includes("too fast")
      ) {
        addLog("[Bot] Throttle kick detected - will use extended reconnect delay");
        botState.wasThrottled = true;
      }

      if (config.discord && config.discord.events && config.discord.events.disconnect) {
        sendDiscordWebhook(`[!] **Kicked**: ${kickReason}`, 0xff0000);
      }
    });

    bot.on("end", (reason) => {
      addLog(`[Bot] Disconnected: ${reason || "Unknown reason"}`);
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false;

      if (config.discord && config.discord.events && config.discord.events.disconnect) {
        sendDiscordWebhook(`[-] **Disconnected**: ${reason || "Unknown"}`, 0xf87171);
      }

      if (botRunning) {
        scheduleReconnect();
      }
    });

    bot.on("error", (err) => {
      const msg = err.message || "";
      addLog(`[Bot] Error: ${msg}`);
      botState.errors.push({ type: "error", message: msg, time: Date.now() });
    });
  } catch (err) {
    addLog(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearBotTimeouts();

  if (!botRunning) {
    addLog("[Bot] Bot stopped, not scheduling reconnect");
    return;
  }

  if (isReconnecting) {
    addLog("[Bot] Reconnect already scheduled, skipping duplicate.");
    return;
  }

  isReconnecting = true;
  botState.reconnectAttempts++;

  const delay = getReconnectDelay();
  addLog(`[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  addLog("[Modules] Initializing all modules...");

  // ---------- AUTO AUTH ----------
  if (config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
    const password = config.utils["auto-auth"].password;
    let authHandled = false;

    const tryAuth = (type) => {
      if (authHandled || !bot || !botState.connected) return;
      authHandled = true;
      if (type === "register") {
        bot.chat(`/register ${password} ${password}`);
        addLog("[Auth] Detected register prompt - sent /register");
      } else {
        bot.chat(`/login ${password}`);
        addLog("[Auth] Detected login prompt - sent /login");
      }
    };

    bot.on("messagestr", (message) => {
      if (authHandled) return;
      const msg = message.toLowerCase();
      if (msg.includes("/register") || msg.includes("register ")) {
        tryAuth("register");
      } else if (msg.includes("/login") || msg.includes("login ")) {
        tryAuth("login");
      }
    });

    setTimeout(() => {
      if (!authHandled && bot && botState.connected) {
        addLog("[Auth] No prompt detected after 10s, sending /login as failsafe");
        bot.chat(`/login ${password}`);
        authHandled = true;
      }
    }, 10000);
  }

  // ---------- CHAT MESSAGES ----------
  if (config.utils["chat-messages"] && config.utils["chat-messages"].enabled) {
    const messages = config.utils["chat-messages"].messages;
    if (config.utils["chat-messages"].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) {
          bot.chat(messages[i]);
          botState.lastActivity = Date.now();
          i = (i + 1) % messages.length;
        }
      }, config.utils["chat-messages"]["repeat-delay"] * 1000);
    } else {
      messages.forEach((msg, idx) => {
        setTimeout(() => {
          if (bot && botState.connected) bot.chat(msg);
        }, idx * 1000);
      });
    }
  }

  // ---------- MOVE TO POSITION ----------
  if (
    config.position &&
    config.position.enabled &&
    !(config.movement && config.movement["circle-walk"] && config.movement["circle-walk"].enabled)
  ) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(
      new GoalBlock(config.position.x, config.position.y, config.position.z),
    );
    addLog("[Position] Navigating to configured position...");
  }

  // ---------- ANTI-AFK ----------
  if (config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
    addInterval(() => {
      if (!bot || !botState.connected) return;
      try { bot.swingArm(); } catch (e) {}
    }, 10000 + Math.floor(Math.random() * 50000));

    addInterval(() => {
      if (!bot || !botState.connected) return;
      try {
        const slot = Math.floor(Math.random() * 9);
        bot.setQuickBarSlot(slot);
      } catch (e) {}
    }, 30000 + Math.floor(Math.random() * 90000));

    if (!(config.movement && config.movement["circle-walk"] && config.movement["circle-walk"].enabled)) {
      addInterval(() => {
        if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
        try {
          const yaw = Math.random() * Math.PI * 2;
          bot.look(yaw, 0, true);
          bot.setControlState("forward", true);
          setTimeout(() => {
            if (bot && typeof bot.setControlState === "function")
              bot.setControlState("forward", false);
          }, 500 + Math.floor(Math.random() * 1500));
          botState.lastActivity = Date.now();
        } catch (e) {
          addLog("[AntiAFK] Walk error: " + e.message);
        }
      }, 120000 + Math.floor(Math.random() * 360000));
    }

    if (config.utils["anti-afk"].sneak) {
      try {
        if (typeof bot.setControlState === "function")
          bot.setControlState("sneak", true);
      } catch (e) {}
    }
  }

  // ---------- MOVEMENT MODULES ----------
  if (config.movement && config.movement.enabled !== false) {
    if (config.movement["circle-walk"] && config.movement["circle-walk"].enabled) {
      startCircleWalk(bot, defaultMove);
    }
    if (
      config.movement["random-jump"] &&
      config.movement["random-jump"].enabled &&
      !(config.movement["circle-walk"] && config.movement["circle-walk"].enabled)
    ) {
      startRandomJump(bot);
    }
    if (config.movement["look-around"] && config.movement["look-around"].enabled) {
      startLookAround(bot);
    }
  }

  // ---------- CUSTOM MODULES ----------
  if (config.modules.avoidMobs && !config.modules.combat) {
    avoidMobs(bot);
  }
  if (config.modules.combat) {
    combatModule(bot, mcData);
  }
  if (config.modules.beds) {
    bedModule(bot, mcData);
  }
  if (config.modules.chat) {
    chatModule(bot);
  }

  addLog("[Modules] All modules initialized!");
}

// ============================================================
// MOVEMENT HELPERS
// ============================================================
function startCircleWalk(bot, defaultMove) {
  const radius = config.movement["circle-walk"].radius;
  let angle = 0;
  let lastPathTime = 0;

  addInterval(() => {
    if (!bot || !botState.connected) return;
    const now = Date.now();
    if (now - lastPathTime < 2000) return;
    lastPathTime = now;
    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(
        new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)),
      );
      angle += Math.PI / 4;
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[CircleWalk] Error: " + e.message);
    }
  }, config.movement["circle-walk"].speed);
}

function startRandomJump(bot) {
  addInterval(() => {
    if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
    try {
      bot.setControlState("jump", true);
      setTimeout(() => {
        if (bot && typeof bot.setControlState === "function")
          bot.setControlState("jump", false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[RandomJump] Error: " + e.message);
    }
  }, config.movement["random-jump"].interval);
}

function startLookAround(bot) {
  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      const yaw = Math.random() * Math.PI * 2 - Math.PI;
      const pitch = (Math.random() * Math.PI) / 2 - Math.PI / 4;
      bot.look(yaw, pitch, false);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[LookAround] Error: " + e.message);
    }
  }, config.movement["look-around"].interval);
}

// ============================================================
// CUSTOM MODULES
// ============================================================
function avoidMobs(bot) {
  const safeDistance = 5;
  addInterval(() => {
    if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
    try {
      const entities = Object.values(bot.entities).filter(
        (e) => e.type === "mob" || (e.type === "player" && e.username !== bot.username),
      );
      for (const e of entities) {
        if (!e.position) continue;
        const distance = bot.entity.position.distanceTo(e.position);
        if (distance < safeDistance) {
          bot.setControlState("back", true);
          setTimeout(() => {
            if (bot && typeof bot.setControlState === "function")
              bot.setControlState("back", false);
          }, 500);
          break;
        }
      }
    } catch (e) {
      addLog("[AvoidMobs] Error: " + e.message);
    }
  }, 2000);
}

function combatModule(bot, mcData) {
  let lastAttackTime = 0;
  let lockedTarget = null;
  let lockedTargetExpiry = 0;

  bot.on("physicsTick", () => {
    if (!bot || !botState.connected) return;
    if (!config.combat["attack-mobs"]) return;

    const now = Date.now();
    if (now - lastAttackTime < 620) return;

    try {
      if (
        lockedTarget &&
        now < lockedTargetExpiry &&
        bot.entities[lockedTarget.id] &&
        lockedTarget.position
      ) {
        const dist = bot.entity.position.distanceTo(lockedTarget.position);
        if (dist < 4) {
          bot.attack(lockedTarget);
          lastAttackTime = now;
          return;
        } else {
          lockedTarget = null;
        }
      }

      const mobs = Object.values(bot.entities).filter(
        (e) =>
          e.type === "mob" &&
          e.position &&
          bot.entity.position.distanceTo(e.position) < 4,
      );
      if (mobs.length > 0) {
        lockedTarget = mobs[0];
        lockedTargetExpiry = now + 3000;
        bot.attack(lockedTarget);
        lastAttackTime = now;
      }
    } catch (e) {
      addLog("[Combat] Error: " + e.message);
    }
  });

  bot.on("health", () => {
    if (!config.combat["auto-eat"]) return;
    try {
      if (bot.food < 14) {
        const food = bot.inventory.items().find((i) => i.foodPoints && i.foodPoints > 0);
        if (food) {
          bot.equip(food, "hand")
            .then(() => bot.consume())
            .catch((e) => addLog("[AutoEat] Error: " + e.message));
        }
      }
    } catch (e) {
      addLog("[AutoEat] Error: " + e.message);
    }
  });
}

function bedModule(bot, mcData) {
  let isTryingToSleep = false;

  addInterval(async () => {
    if (!bot || !botState.connected) return;
    if (!config.beds["place-night"]) return;

    try {
      const isNight = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500;

      if (isNight && !isTryingToSleep) {
        const bedBlock = bot.findBlock({
          matching: (block) => block.name.includes("bed"),
          maxDistance: 8,
        });

        if (bedBlock) {
          isTryingToSleep = true;
          try {
            await bot.sleep(bedBlock);
            addLog("[Bed] Sleeping...");
          } catch (e) {
            // can't sleep
          } finally {
            isTryingToSleep = false;
          }
        }
      }
    } catch (e) {
      isTryingToSleep = false;
      addLog("[Bed] Error: " + e.message);
    }
  }, 10000);
}

function chatModule(bot) {
  bot.on("chat", (username, message) => {
    if (!bot || username === bot.username) return;

    try {
      if (
        config.discord &&
        config.discord.enabled &&
        config.discord.events &&
        config.discord.events.chat
      ) {
        sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);
      }

      if (config.chat && config.chat.respond) {
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.includes("hello") || lowerMsg.includes("hi")) {
          bot.chat(`Hello, ${username}!`);
        }
        if (message.startsWith("!tp ")) {
          const target = message.split(" ")[1];
          if (target) bot.chat(`/tp ${target}`);
        }
      }
    } catch (e) {
      addLog("[Chat] Error: " + e.message);
    }
  });
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================
const readline = require("readline");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  if (!bot || !botState.connected) {
    addLog("[Console] Bot not connected");
    return;
  }

  const trimmed = line.trim();
  if (trimmed.startsWith("say ")) {
    bot.chat(trimmed.slice(4));
  } else if (trimmed.startsWith("cmd ")) {
    bot.chat("/" + trimmed.slice(4));
  } else if (trimmed === "status") {
    addLog(
      `Connected: ${botState.connected}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`,
    );
  } else {
    bot.chat(trimmed);
  }
});

// ============================================================
// DISCORD WEBHOOK INTEGRATION
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (
    !config.discord ||
    !config.discord.enabled ||
    !config.discord.webhookUrl ||
    config.discord.webhookUrl.includes("YOUR_DISCORD")
  )
    return;

  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) {
    addLog("[Discord] Rate limited - skipping webhook");
    return;
  }
  lastDiscordSend = now;

  const protocol = config.discord.webhookUrl.startsWith("https") ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);

  const payload = JSON.stringify({
    username: config.name,
    embeds: [
      {
        description: content,
        color: color,
        timestamp: new Date().toISOString(),
        footer: { text: "AFK Bot" },
      },
    ],
  });

  const options = {
    hostname: urlParts.hostname,
    port: 443,
    path: urlParts.pathname + urlParts.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload, "utf8"),
    },
  };

  const req = protocol.request(options, (res) => {});

  req.on("error", (e) => {
    addLog(`[Discord] Error sending webhook: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

// ============================================================
// CRASH RECOVERY
// ============================================================
process.on("uncaughtException", (err) => {
  const msg = err.message || "Unknown";
  addLog(`[FATAL] Uncaught Exception: ${msg}`);
  botState.errors.push({ type: "uncaught", message: msg, time: Date.now() });

  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  const isNetworkError =
    msg.includes("PartialReadError") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("timed out") ||
    msg.includes("write after end") ||
    msg.includes("This socket has been ended");

  if (isNetworkError) {
    addLog("[FATAL] Known network/protocol error - recovering gracefully...");
  }

  clearAllIntervals();
  botState.connected = false;

  if (isReconnecting) {
    addLog("[FATAL] isReconnecting was stuck - resetting before crash recovery");
    isReconnecting = false;
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  }

  setTimeout(() => {
    scheduleReconnect();
  }, isNetworkError ? 5000 : 10000);
});

process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  addLog(`[FATAL] Unhandled Rejection: ${reason}`);
  botState.errors.push({ type: "rejection", message: msg, time: Date.now() });
  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  const isNetworkError =
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("timed out") ||
    msg.includes("PartialReadError");

  if (isNetworkError && !isReconnecting) {
    addLog("[FATAL] Network rejection — triggering reconnect...");
    clearAllIntervals();
    botState.connected = false;
    if (bot) {
      try { bot.end(); } catch (_) {}
      bot = null;
    }
    scheduleReconnect();
  }
});

// Graceful shutdown for Render redeploys
process.on("SIGTERM", () => {
  addLog("[System] SIGTERM received — shutting down gracefully for Render redeploy.");
  botRunning = false;
  keepAlive.stop();
  if (bot) {
    try { bot.quit(); } catch (_) {}
  }
  setTimeout(() => process.exit(0), 2000);
});

process.on("SIGINT", () => {
  addLog("[System] SIGINT received — shutting down.");
  botRunning = false;
  keepAlive.stop();
  if (bot) {
    try { bot.quit(); } catch (_) {}
  }
  setTimeout(() => process.exit(0), 2000);
});

// ============================================================
// START THE BOT
// ============================================================
addLog("=".repeat(50));
addLog(`  ${config.name} v${pkg.version} - Render Ready Edition`);
addLog("=".repeat(50));
addLog(`Server: ${config.server.ip}:${config.server.port}`);
addLog(`Version: ${config.server.version}`);
addLog(`Account: ${config["bot-account"].username} (${config["bot-account"].type})`);
addLog(`Auto-Reconnect: ${config.utils["auto-reconnect"] ? "Enabled" : "Disabled"}`);
addLog(`KeepAlive: ${process.env.KEEP_ALIVE === "0" ? "Disabled by env" : "Enabled"}`);
addLog(`Memory guard: ${MEMORY_LIMIT_MB} MB RSS`);
addLog(`Health: GET /health | Diagnostics: GET /diag`);
addLog("=".repeat(50));

createBot();
