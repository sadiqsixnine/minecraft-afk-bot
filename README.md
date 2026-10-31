# minecraft-afk-bot

AFK bot for Minecraft servers (mineflayer) with a small web dashboard, meant to
run on Render as a **Web Service**.

Web UI: `/` · Logs + console: `/logs` · Health: `/health` · Diagnostics: `/diag`

> The dashboard, `/logs` and `/diag` have **no authentication**. Anyone with the
> URL can read the bot logs and send in-game chat/commands. Keep the URL private
> (or put Access Control in front of it in Render).

---

## Why does Render say the service is "suspended"?

There are **three different things** people mean when they say Render suspended
their bot. They look similar in the dashboard but have completely different
fixes.

| What you see | Real cause | Fix |
| --- | --- | --- |
| Service went quiet / "suspended" after ~15 min, waking it takes ~1 min | **Free-tier idle spin-down.** Render free web services sleep after 15 minutes with **no inbound HTTP request**. Minecraft and Discord traffic is *outbound*, so it does not count. | Keep-alive self-ping (built in, see below) or an external cron pinging `/ping`. |
| Dashboard banner with a **Resume** button, logs simply stop | **750 free instance hours used up.** Free web services get 750 h/month per workspace; one 24/7 service burns ~720–744 h by itself. Any second free service (or a heavy month) pushes you over → *all* free services are suspended until the 1st of next month. | Check **Dashboard → Billing → Free instance hours**. Wait for the reset, move to a paid instance ($7/mo Starter), or run the bot elsewhere. |
| Account/service suspended with a policy notice | **Acceptable-use flag.** Render's free tier is for web services; running a game bot 24/7 *and* self-pinging to defeat spin-down can be treated as misusing the free tier. | Use a paid instance / a VPS / your own machine, and stop the self-ping (`KEEP_ALIVE=0`). |
| Deploy fails, port never opens | Deployed as a **Background Worker** or wrong start command. Free plan only offers Web Services. | Create a **Web Service**, `npm start`, port from `$PORT`. |

The quickest way to tell them apart: open **`/diag`** on the live service and
look at `keepAlive` + `hints`, then check **Dashboard → Events** and
**Dashboard → Billing**. Idle spin-down and hourly-limit suspension are *not*
the same problem, and no amount of code can defeat the hourly limit.

### What this repo does about idle spin-down

`keepalive.js` self-pings the service's own public URL:

* target = `KEEP_ALIVE_URL` → `SELF_PING_URL` → `PUBLIC_URL` →
  `RENDER_EXTERNAL_URL` → `RENDER_EXTERNAL_HOSTNAME` (the last two are set by
  Render automatically);
* every **5 minutes** (clamped to 1–14 min, so it can never drift past the
  15-minute limit);
* retries 20 s after a failure, and the first ping fires 20 s after boot;
* refuses `localhost`/`127.0.0.1` targets (a loopback request never reaches
  Render's router, so it does not reset the idle timer);
* rewrites `/` and `/robots.txt` to `/ping`, because Render answers
  `/robots.txt` itself while a service is asleep — pinging that path keeps the
  service asleep forever while looking healthy.

It is a mitigation for the free tier, not a guarantee: Render may also restart
free instances at any time, and keeping the service awake consumes the same
instance hours as just running it.

### Belt and braces: an external pinger

A self-ping cannot run while the process is asleep — only *external* traffic
wakes it. Adding a free external monitor makes the setup much more forgiving:

* cron-job.org or UptimeRobot → `GET https://<your-service>.onrender.com/ping`
  every 5 minutes.
* Never point a monitor at `/robots.txt`: Render answers that path itself while
  the service is down, so the check looks green while the bot stays asleep.

If you hit the 750-hour ceiling, the honest options are:

1. **Render Starter instance** — no spin-down, no shared hour pool.
2. **A small VPS / your own PC** — cheapest per hour for a 24/7 game bot.
3. **A different free host** that explicitly allows always-on processes.

---

## Deploy on Render

### Option A — Blueprint (recommended)

`render.yaml` is included. In Render: **New → Blueprint → pick this repo**.
It creates one free Web Service with the right build/start commands, health
check path, Node version and memory limits.

### Option B — Manual Web Service

| Setting | Value |
| --- | --- |
| Type | **Web Service** (not Background Worker) |
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/health` |
| Instance type | Free (or Starter for real 24/7) |

Render injects `PORT` and `RENDER_EXTERNAL_URL` — the app reads both.

### Local

```bash
npm install
npm start
# dashboard: http://localhost:5000/
```

---

## Configuration

`settings.json` holds the server, account and module settings. On Render you can
override the important ones with env vars (see `.env.example`), so the bot can be
re-pointed from the dashboard without a code change:

| Env var | Meaning |
| --- | --- |
| `MC_HOST`, `MC_PORT`, `MC_VERSION` | Minecraft server to join |
| `MC_USERNAME`, `MC_AUTH`, `MC_PASSWORD` | Bot account (`offline` / `microsoft`) |
| `AUTH_PASSWORD` | Password used by auto-auth `/login` / `/register` |
| `KEEP_ALIVE` | `0` disables the self-ping |
| `KEEP_ALIVE_URL` | Override ping target |
| `KEEP_ALIVE_INTERVAL_MS` | Ping interval, clamped to 1–14 min (default 300000) |
| `MEMORY_LIMIT_MB` | RSS guard; process restarts itself above this (default 460) |
| `MC_DEBUG` | `1` shows raw protocol stack traces in the logs |

---

## Hardening added for Render

* **`keepalive.js`** — robust self-ping with retries, timeouts and real
  status/latency tracking (see above).
* **`GET /diag`** — JSON dump: uptime, bot state, keep-alive health, Render env
  vars, memory and a plain-language `hints[]` list for whatever is wrong.
* **Memory guard** — free instances get 512 MB. The bot logs
  `RSS`/`Heap` every 5 minutes and restarts itself cleanly at
  `MEMORY_LIMIT_MB` (default 460) instead of being OOM-killed, which looks
  exactly like a suspension in the dashboard.
* **Quieter logs** — raw mineflayer stack traces (`write EPIPE`, …) are hidden
  unless `MC_DEBUG=1`; they used to flood Render's log storage on every
  reconnect.
* **Env config** — no code edit needed to change server/account.
* **Graceful SIGTERM** — on redeploy the bot quits the Minecraft session instead
  of being killed mid-tick.

---

## Troubleshooting checklist

1. `GET /diag` → is `keepAlive.enabled` true, and is `lastStatus` 200?
2. `GET /health` → is the bot `connected`?
3. Render **Events** tab → does it say *instance suspended* (sleep) or
   *service suspended* (billing)?
4. Render **Billing** → how many instance hours are left this month?
5. Render **Logs** → is the bot stuck in a reconnect loop (wrong host/port,
   Aternos server offline, wrong version, cracked/online-mode mismatch)?

### Fast fixes for a reconnect loop

* Aternos servers must be **started** — the bot cannot wake them.
* Aternos address changes every time the server restarts; update `MC_HOST` /
  `MC_PORT`.
* Online-mode servers need a real (Microsoft) account, not `offline`.
* Match `MC_VERSION` to the server (or use a ViaVersion setup).

---

## নোট (বাংলা)

* Render free tier-এ web service **১৫ মিনিট কোনো inbound request না এলে suspend
  (sleep)** হয়ে যায় — Minecraft/Discord traffic outbound, তাই সেটা গোনা হয় না।
  এই repo-তে এখন প্রতি **৫ মিনিটে** নিজের public URL-এ self-ping হয়, তাই idle
  sleep হবে না (ডিপ্লয়ের পর `/diag` খুলে দেখুন `keepAlive.enabled: true`)।
* কিন্তু dashboard-এ **Resume বাটনসহ "Suspended"** দেখালে সেটা sleep নয় —
  মাসিক **৭৫০ free instance hours** শেষ হয়ে গেছে। ২৪/৭ চললে একটাই সার্ভিসে
  ~৭২০–৭৪৪ ঘণ্টা লাগে, তাই দ্বিতীয় free service চললে বা মাসের শেষে লিমিট
  শেষ হয় → পরের মাসের ১ তারিখ পর্যন্ত suspend থাকে। এটা কোড দিয়ে ঠিক হয় না;
  Starter instance বা VPS লাগবে।
* `/diag` endpoint-এ `hints` দেখলেই বোঝা যাবে সমস্যা কোনটা।
