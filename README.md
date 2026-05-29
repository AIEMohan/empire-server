# EMPIRE SERVER — VAULT · APEX · CIPHER

One backend server that powers all three platforms. All API keys live here as
environment variables — never in your HTML files, never exposed to browsers.

---

## What this server does

| Endpoint | Powers | What it returns |
|---|---|---|
| `POST /api/leads` | VAULT | Real businesses from Google Places |
| `GET /api/signal/:symbol` | APEX | Real RSI/MACD/EMA + buy/sell signal |
| `GET /api/quote/:symbol` | APEX | Live price snapshot |
| `GET /api/account?mode=paper` | APEX | Real Alpaca balance |
| `POST /api/order` | APEX | Executes a real trade on Alpaca |
| `GET /api/news` | CIPHER | Live RSS headlines |
| `POST /api/ai` | All three | Claude AI analysis |
| `GET /` | — | Health check (shows which keys are configured) |

---

## DEPLOY TO RENDER (free) — step by step

### 1. Put this folder on GitHub
- Go to github.com → New repository → name it `empire-server` → Create
- Upload all three files: `server.js`, `package.json`, `README.md`

### 2. Create the Render service
- Go to render.com → sign up (free, no card needed)
- Click **New +** → **Web Service**
- Connect your GitHub → pick `empire-server`
- Settings:
  - **Runtime:** Node
  - **Build Command:** `npm install`
  - **Start Command:** `npm start`
  - **Instance Type:** Free

### 3. Add your keys as Environment Variables
In Render, open the **Environment** tab and add each of these
(only add the ones you have — the server works with whatever is present):

```
GOOGLE_PLACES_KEY     = your new Google Places key
POLYGON_KEY           = your new Polygon.io key
ANTHROPIC_KEY         = your Anthropic key (sk-ant-...)
ALPACA_LIVE_KEY       = your new Alpaca live key
ALPACA_LIVE_SECRET    = your new Alpaca live secret
ALPACA_PAPER_KEY      = your new Alpaca paper key
ALPACA_PAPER_SECRET   = your new Alpaca paper secret
ALLOWED_ORIGINS       = https://vault-intel.netlify.app,https://your-apex.netlify.app,https://your-cipher.netlify.app
```

### 4. Deploy
- Click **Create Web Service**
- Wait ~2 minutes for build
- You get a URL like: `https://empire-server.onrender.com`
- Visit it — you should see `EMPIRE SERVER ONLINE` and which services are ready

### 5. Tell me your server URL
Paste your `https://...onrender.com` URL back in chat and I will wire all three
apps to call it. You won't touch the code — I update the HTML files for you.

---

## SECURITY NOTES
- Keys live ONLY on Render as environment variables. They are never in the HTML.
- `ALLOWED_ORIGINS` restricts who can call your server. Set it to your Netlify URLs.
- Rate limiting is built in (120 requests/min per IP) to prevent runaway costs.
- The free Render tier sleeps after 15 min idle; first request after sleep takes ~30s
  to wake. Upgrade to $7/mo "Starter" for always-on once you have clients.

---

## IMPORTANT
Rotate every key you ever pasted in chat before putting it here. Use fresh keys only.
