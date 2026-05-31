// ═══════════════════════════════════════════════════════════
//  EMPIRE SERVER — Unified Backend for VAULT · APEX · CIPHER
//  One server. Three platforms. All keys protected.
//
//  Handles:
//   • Google Places  → VAULT real business leads
//   • Polygon.io     → APEX real market data + indicators
//   • Alpaca         → APEX trade execution + account balance
//   • Anthropic      → AI analysis for VAULT / APEX / CIPHER
//   • RSS news       → CIPHER live intelligence feed
//
//  All API keys live in environment variables on the server.
//  They are NEVER exposed to the browser. This is the secure way.
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ───────────────────────────────────────────────────────────
//  SECURITY — CORS
//  Only your own apps (and local testing) may call this server.
//  Add your Netlify URLs to ALLOWED_ORIGINS env var, comma-separated.
//  Example: https://vault-intel.netlify.app,https://apex-intel.netlify.app
// ───────────────────────────────────────────────────────────
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, same-origin)
    if (!origin) return callback(null, true);
    // If no allowlist is configured yet, allow all (you'll lock this down after deploy)
    if (ALLOWED.length === 0) return callback(null, true);
    if (ALLOWED.indexOf(origin) !== -1) return callback(null, true);
    return callback(null, true); // permissive for now; tighten later by returning an Error
  }
}));

// ───────────────────────────────────────────────────────────
//  Simple rate limiting (protects against abuse / runaway costs)
// ───────────────────────────────────────────────────────────
const hits = {};
const RATE_LIMIT = 120;        // requests
const RATE_WINDOW = 60 * 1000; // per minute per IP

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  if (!hits[ip]) hits[ip] = [];
  hits[ip] = hits[ip].filter(t => now - t < RATE_WINDOW);
  if (hits[ip].length >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Rate limit exceeded. Slow down.' });
  }
  hits[ip].push(now);
  next();
});

// ───────────────────────────────────────────────────────────
//  KEYS — pulled from environment variables (set on Render)
// ───────────────────────────────────────────────────────────
const KEYS = {
  GOOGLE:            process.env.GOOGLE_PLACES_KEY || '',
  POLYGON:           process.env.POLYGON_KEY || '',
  ANTHROPIC:         process.env.ANTHROPIC_KEY || '',
  ALPACA_LIVE_KEY:   process.env.ALPACA_LIVE_KEY || '',
  ALPACA_LIVE_SECRET:process.env.ALPACA_LIVE_SECRET || '',
  ALPACA_PAPER_KEY:  process.env.ALPACA_PAPER_KEY || '',
  ALPACA_PAPER_SECRET:process.env.ALPACA_PAPER_SECRET || '',
};

const ALPACA_LIVE_DATA = 'https://data.alpaca.markets';
const ALPACA_LIVE_TRADE = 'https://api.alpaca.markets';
const ALPACA_PAPER_TRADE = 'https://paper-api.alpaca.markets';

// Helper: pick Alpaca creds + endpoint by mode
function alpaca(mode) {
  if (mode === 'live') {
    return {
      key: KEYS.ALPACA_LIVE_KEY,
      secret: KEYS.ALPACA_LIVE_SECRET,
      trade: ALPACA_LIVE_TRADE,
    };
  }
  return {
    key: KEYS.ALPACA_PAPER_KEY,
    secret: KEYS.ALPACA_PAPER_SECRET,
    trade: ALPACA_PAPER_TRADE,
  };
}

// ═══════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'EMPIRE SERVER ONLINE',
    services: {
      vault_leads: KEYS.GOOGLE ? 'ready' : 'no key',
      apex_market: KEYS.POLYGON ? 'ready' : 'no key',
      apex_trading: KEYS.ALPACA_PAPER_KEY ? 'ready' : 'no key',
      ai_analysis: KEYS.ANTHROPIC ? 'ready' : 'no key',
      cipher_news: 'ready',
    },
    time: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════
//  VAULT — GOOGLE PLACES LEADS
//  POST /api/leads  { query: "dental offices Chicago", limit: 10 }
// ═══════════════════════════════════════════════════════════
app.post('/api/leads', async (req, res) => {
  try {
    if (!KEYS.GOOGLE) return res.status(400).json({ error: 'Google Places key not configured on server.' });
    const { query, limit = 12 } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query.' });

    // Text Search (New Places API)
    const searchRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEYS.GOOGLE,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.websiteUri,places.businessStatus,places.priceLevel',
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: Math.min(limit, 20) }),
    });

    const data = await searchRes.json();
    if (data.error) return res.status(400).json({ error: data.error.message || 'Google Places error', detail: data.error });

    const leads = (data.places || []).map(p => ({
      name: p.displayName?.text || 'Unknown',
      address: p.formattedAddress || '',
      phone: p.nationalPhoneNumber || '',
      rating: p.rating || null,
      reviews: p.userRatingCount || 0,
      website: p.websiteUri || '',
      status: p.businessStatus || '',
      priceLevel: p.priceLevel || '',
    }));

    res.json({ count: leads.length, leads });
  } catch (e) {
    res.status(500).json({ error: 'Server error fetching leads', detail: String(e) });
  }
});

// ═══════════════════════════════════════════════════════════
//  APEX — POLYGON MARKET DATA + INDICATORS
//  GET /api/quote/:symbol           → latest price snapshot
//  GET /api/bars/:symbol?days=50    → historical daily bars
//  GET /api/signal/:symbol          → computed RSI/MACD/EMA + signal
// ═══════════════════════════════════════════════════════════
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    if (!KEYS.POLYGON) return res.status(400).json({ error: 'Polygon key not configured on server.' });
    const sym = req.params.symbol.toUpperCase();
    const url = `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${KEYS.POLYGON}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status === 'ERROR') return res.status(400).json({ error: d.error || 'Polygon error' });
    const bar = (d.results || [])[0];
    if (!bar) return res.status(404).json({ error: 'No data for symbol' });
    res.json({
      symbol: sym,
      price: bar.c,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      volume: bar.v,
      change: +(((bar.c - bar.o) / bar.o) * 100).toFixed(2),
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error fetching quote', detail: String(e) });
  }
});

app.get('/api/bars/:symbol', async (req, res) => {
  try {
    if (!KEYS.POLYGON) return res.status(400).json({ error: 'Polygon key not configured on server.' });
    const sym = req.params.symbol.toUpperCase();
    const days = Math.min(parseInt(req.query.days) || 60, 200);
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days - 20); // pad for weekends/holidays
    const fmt = d => d.toISOString().slice(0, 10);
    const url = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fmt(start)}/${fmt(end)}?adjusted=true&sort=asc&limit=300&apiKey=${KEYS.POLYGON}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status === 'ERROR') return res.status(400).json({ error: d.error || 'Polygon error' });
    const bars = (d.results || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    res.json({ symbol: sym, count: bars.length, bars });
  } catch (e) {
    res.status(500).json({ error: 'Server error fetching bars', detail: String(e) });
  }
});

// Indicator math
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(1);
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return +ema.toFixed(2);
}

function calcMACD(closes) {
  if (closes.length < 26) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (ema12 === null || ema26 === null) return null;
  return +(ema12 - ema26).toFixed(2);
}

app.get('/api/signal/:symbol', async (req, res) => {
  try {
    if (!KEYS.POLYGON) return res.status(400).json({ error: 'Polygon key not configured on server.' });
    const sym = req.params.symbol.toUpperCase();
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 120);
    const fmt = d => d.toISOString().slice(0, 10);
    const url = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fmt(start)}/${fmt(end)}?adjusted=true&sort=asc&limit=300&apiKey=${KEYS.POLYGON}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status === 'ERROR') return res.status(400).json({ error: d.error || 'Polygon error' });
    const closes = (d.results || []).map(b => b.c);
    if (closes.length < 30) return res.status(404).json({ error: 'Not enough data for signal' });

    const price = closes[closes.length - 1];
    const rsi = calcRSI(closes);
    const macd = calcMACD(closes);
    const ema50 = calcEMA(closes, 50);
    const ema20 = calcEMA(closes, 20);

    // Simple confluence scoring
    let score = 0;
    const reasons = [];
    if (rsi !== null && rsi < 35) { score += 2; reasons.push('RSI oversold'); }
    else if (rsi !== null && rsi > 70) { score -= 2; reasons.push('RSI overbought'); }
    if (macd !== null && macd > 0) { score += 1; reasons.push('MACD positive'); }
    else if (macd !== null && macd < 0) { score -= 1; reasons.push('MACD negative'); }
    if (ema20 !== null && ema50 !== null && ema20 > ema50) { score += 1; reasons.push('EMA bullish cross'); }
    else if (ema20 !== null && ema50 !== null && ema20 < ema50) { score -= 1; reasons.push('EMA bearish'); }
    if (price > ema20) { score += 1; reasons.push('Above short EMA'); }

    let action = 'HOLD';
    if (score >= 3) action = 'BUY';
    else if (score <= -2) action = 'SELL';
    const confidence = Math.min(92, 55 + Math.abs(score) * 7);

    res.json({
      symbol: sym,
      price: +price.toFixed(2),
      indicators: { rsi, macd, ema20, ema50 },
      action,
      confidence,
      reasons,
      target: action === 'BUY' ? +(price * 1.05).toFixed(2) : action === 'SELL' ? +(price * 0.97).toFixed(2) : null,
      stop: action === 'BUY' ? +(price * 0.98).toFixed(2) : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error computing signal', detail: String(e) });
  }
});

// ═══════════════════════════════════════════════════════════
//  APEX — ALPACA ACCOUNT + ORDERS
//  GET  /api/account?mode=paper|live
//  GET  /api/positions?mode=paper|live
//  POST /api/order  { mode, symbol, notional|qty, side, type, time_in_force }
// ═══════════════════════════════════════════════════════════
app.get('/api/account', async (req, res) => {
  try {
    const mode = req.query.mode === 'live' ? 'live' : 'paper';
    const a = alpaca(mode);
    if (!a.key) return res.status(400).json({ error: `Alpaca ${mode} keys not configured on server.` });
    const r = await fetch(`${a.trade}/v2/account`, {
      headers: { 'APCA-API-KEY-ID': a.key, 'APCA-API-SECRET-KEY': a.secret },
    });
    const d = await r.json();
    if (d.code) return res.status(400).json({ error: d.message || 'Alpaca error', detail: d });
    res.json({
      mode,
      buying_power: d.buying_power,
      cash: d.cash,
      equity: d.equity,
      portfolio_value: d.portfolio_value,
      status: d.status,
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error fetching account', detail: String(e) });
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const mode = req.query.mode === 'live' ? 'live' : 'paper';
    const a = alpaca(mode);
    if (!a.key) return res.status(400).json({ error: `Alpaca ${mode} keys not configured on server.` });
    const r = await fetch(`${a.trade}/v2/positions`, {
      headers: { 'APCA-API-KEY-ID': a.key, 'APCA-API-SECRET-KEY': a.secret },
    });
    const d = await r.json();
    if (d.code) return res.status(400).json({ error: d.message || 'Alpaca error' });
    res.json({ mode, positions: d });
  } catch (e) {
    res.status(500).json({ error: 'Server error fetching positions', detail: String(e) });
  }
});

app.post('/api/order', async (req, res) => {
  try {
    const { mode = 'paper', symbol, notional, qty, side = 'buy', type = 'market', time_in_force = 'day', take_profit, stop_loss } = req.body;
    const a = alpaca(mode === 'live' ? 'live' : 'paper');
    if (!a.key) return res.status(400).json({ error: `Alpaca ${mode} keys not configured on server.` });
    if (!symbol) return res.status(400).json({ error: 'Missing symbol.' });

    const order = { symbol: symbol.toUpperCase(), side, type };
    const round2 = v => Math.round(parseFloat(v) * 100) / 100;
    const hasExit = (take_profit != null && take_profit !== '') || (stop_loss != null && stop_loss !== '');

    if (hasExit) {
      // Stop-loss / take-profit (bracket or OTO) — Alpaca requires WHOLE-SHARE qty, not notional.
      const shares = parseInt(qty, 10);
      if (!shares || shares < 1) {
        return res.status(400).json({ error: 'A stop-loss/target order needs at least 1 whole share. Increase the dollar amount for this stock.' });
      }
      order.qty = String(shares);
      order.time_in_force = (time_in_force === 'gtc' ? 'gtc' : 'day');
      if (take_profit && stop_loss) {
        order.order_class = 'bracket';
        order.take_profit = { limit_price: round2(take_profit) };
        order.stop_loss = { stop_price: round2(stop_loss) };
      } else if (stop_loss) {
        order.order_class = 'oto';
        order.stop_loss = { stop_price: round2(stop_loss) };
      } else {
        order.order_class = 'oto';
        order.take_profit = { limit_price: round2(take_profit) };
      }
    } else {
      // Plain order — dollar (notional) or share based.
      order.time_in_force = time_in_force;
      if (notional) order.notional = String(notional);
      else if (qty) order.qty = String(qty);
      else return res.status(400).json({ error: 'Provide notional or qty.' });
    }

    const r = await fetch(`${a.trade}/v2/orders`, {
      method: 'POST',
      headers: {
        'APCA-API-KEY-ID': a.key,
        'APCA-API-SECRET-KEY': a.secret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(order),
    });
    const d = await r.json();
    if (d.code) return res.status(400).json({ error: d.message || 'Alpaca order error', detail: d });
    res.json({ success: true, order: { id: d.id, status: d.status, symbol: d.symbol, side: d.side, notional: d.notional, qty: d.qty, order_class: d.order_class, legs: d.legs ? d.legs.length : 0 } });
  } catch (e) {
    res.status(500).json({ error: 'Server error placing order', detail: String(e) });
  }
});

// Market clock — lets the app honestly show whether orders will fill now
app.get('/api/clock', async (req, res) => {
  try {
    const mode = req.query.mode === 'live' ? 'live' : 'paper';
    const a = alpaca(mode);
    if (!a.key) return res.json({ is_open: false, note: 'no key' });
    const r = await fetch(`${a.trade}/v2/clock`, {
      headers: { 'APCA-API-KEY-ID': a.key, 'APCA-API-SECRET-KEY': a.secret },
    });
    const d = await r.json();
    res.json({ is_open: !!d.is_open, next_open: d.next_open, next_close: d.next_close });
  } catch (e) {
    res.status(500).json({ error: 'Server error fetching clock', detail: String(e) });
  }
});

// Closed orders — real filled trades, the source of truth for the track record
app.get('/api/closed', async (req, res) => {
  try {
    const mode = req.query.mode === 'live' ? 'live' : 'paper';
    const a = alpaca(mode);
    if (!a.key) return res.status(400).json({ error: `Alpaca ${mode} keys not configured on server.` });
    const r = await fetch(`${a.trade}/v2/orders?status=closed&limit=200&direction=asc`, {
      headers: { 'APCA-API-KEY-ID': a.key, 'APCA-API-SECRET-KEY': a.secret },
    });
    const d = await r.json();
    if (d.code) return res.status(400).json({ error: d.message || 'Alpaca error' });
    const fills = (Array.isArray(d) ? d : [])
      .filter(o => o.filled_at && o.filled_avg_price && parseFloat(o.filled_qty) > 0)
      .map(o => ({
        symbol: o.symbol,
        side: o.side,
        qty: parseFloat(o.filled_qty),
        price: parseFloat(o.filled_avg_price),
        filled_at: o.filled_at,
      }));
    res.json({ mode, count: fills.length, fills });
  } catch (e) {
    res.status(500).json({ error: 'Server error fetching closed orders', detail: String(e) });
  }
});

// ═══════════════════════════════════════════════════════════
//  AI ANALYSIS — ANTHROPIC (VAULT / APEX / CIPHER)
//  POST /api/ai  { system, prompt, max_tokens }
// ═══════════════════════════════════════════════════════════
app.post('/api/ai', async (req, res) => {
  try {
    if (!KEYS.ANTHROPIC) return res.status(400).json({ error: 'Anthropic key not configured on server.' });
    const { system = '', prompt = '', max_tokens = 1200 } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt.' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': KEYS.ANTHROPIC,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message || 'Anthropic error' });
    const text = (d.content || []).map(c => c.text || '').join('');
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: 'Server error calling AI', detail: String(e) });
  }
});

// ═══════════════════════════════════════════════════════════
//  CIPHER — RSS NEWS FETCH (server-side, no CORS issues)
//  GET /api/news
// ═══════════════════════════════════════════════════════════
const RSS_FEEDS = [
  'https://feeds.bbci.co.uk/news/business/rss.xml',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.marketwatch.com/marketwatch/topstories/',
  'https://www.cnbc.com/id/100003114/device/rss/rss.html',
  'https://rss.cnn.com/rss/money_latest.rss',
  'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
];

function fetchWithTimeout(url, ms) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmpireServer/1.0)' },
    })
      .then(r => r.text())
      .then(txt => { clearTimeout(t); resolve(txt); })
      .catch(() => { clearTimeout(t); resolve(''); });
  });
}

app.get('/api/news', async (req, res) => {
  try {
    const out = [];
    // fetch all feeds in parallel, each capped at 6s so one slow feed can't stall the response
    const xmls = await Promise.all(RSS_FEEDS.map(f => fetchWithTimeout(f, 6000)));
    xmls.forEach((xml, idx) => {
      if (!xml) return;
      const feed = RSS_FEEDS[idx];
      const source = feed.includes('bbc') ? 'BBC'
        : feed.includes('marketwatch') ? 'MARKETWATCH'
        : feed.includes('cnbc') ? 'CNBC'
        : feed.includes('cnn') ? 'CNN'
        : feed.includes('dj.com') ? 'WSJ' : 'NEWS';
      const items = xml.split(/<item[ >]/).slice(1, 5);
      items.forEach(it => {
        const tm = it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
        const title = tm ? tm[1].trim() : '';
        if (title && title.length > 20) out.push({ title, source });
      });
    });
    res.json({ count: out.length, headlines: out });
  } catch (e) {
    res.status(500).json({ error: 'Server error fetching news', detail: String(e) });
  }
});

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EMPIRE SERVER running on port ${PORT}`);
});
