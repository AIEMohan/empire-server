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

// Basic hardening headers on every response.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

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

function clientIp(req){
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.connection.remoteAddress || 'unknown';
}

app.use((req, res, next) => {
  const ip = clientIp(req);
  const now = Date.now();
  if (!hits[ip]) hits[ip] = [];
  hits[ip] = hits[ip].filter(t => now - t < RATE_WINDOW);
  if (hits[ip].length >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Rate limit exceeded. Slow down.' });
  }
  hits[ip].push(now);
  next();
});

// Periodically purge stale IP buckets so memory can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const ip in hits) {
    hits[ip] = hits[ip].filter(t => now - t < RATE_WINDOW);
    if (hits[ip].length === 0) delete hits[ip];
  }
  for (const ip in aiHits) {
    aiHits[ip] = aiHits[ip].filter(t => now - t < AI_WINDOW);
    if (aiHits[ip].length === 0) delete aiHits[ip];
  }
}, 5 * 60 * 1000);

// Stricter, separate budget for the EXPENSIVE AI endpoint (real $ per call).
// A bot hammering /api/ai is the classic token-drain attack — this caps it hard.
const aiHits = {};
const AI_LIMIT = 12;            // AI calls
const AI_WINDOW = 60 * 1000;    // per minute per IP
function aiRateLimit(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  if (!aiHits[ip]) aiHits[ip] = [];
  aiHits[ip] = aiHits[ip].filter(t => now - t < AI_WINDOW);
  if (aiHits[ip].length >= AI_LIMIT) {
    return res.status(429).json({ error: 'Too many AI requests. Please wait a minute.' });
  }
  aiHits[ip].push(now);
  next();
}

// Reusable limiter for other paid/sensitive endpoints (Google Places, order placement).
function makeLimiter(limit, windowMs, msg){
  const store = {};
  return function(req, res, next){
    const ip = clientIp(req);
    const now = Date.now();
    if (!store[ip]) store[ip] = [];
    store[ip] = store[ip].filter(t => now - t < windowMs);
    if (store[ip].length >= limit) return res.status(429).json({ error: msg || 'Too many requests. Please wait.' });
    store[ip].push(now);
    next();
  };
}
const leadsLimiter = makeLimiter(20, 60 * 1000, 'Too many lead searches. Please wait a minute.');
const orderLimiter = makeLimiter(30, 60 * 1000, 'Too many orders too quickly. Please wait.');

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
      database: process.env.DATABASE_URL ? 'ready' : 'no database',
    },
    time: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════
//  VAULT — GOOGLE PLACES LEADS
//  POST /api/leads  { query: "dental offices Chicago", limit: 10 }
// ═══════════════════════════════════════════════════════════
app.post('/api/leads', leadsLimiter, async (req, res) => {
  try {
    if (!KEYS.GOOGLE) return res.status(400).json({ error: 'Google Places key not configured on server.' });
    let { query, limit = 12 } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query.' });
    query = String(query).slice(0, 200);
    limit = Math.min(Math.max(parseInt(limit) || 12, 1), 20);

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
    res.status(500).json({ error: 'Server error fetching leads' });
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
    const sym = String(req.params.symbol||"").toUpperCase().trim();
    if (!/^[A-Z]{1,6}$/.test(sym)) return res.status(400).json({ error: "Invalid ticker symbol." });
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
    res.status(500).json({ error: 'Server error fetching quote' });
  }
});

app.get('/api/bars/:symbol', async (req, res) => {
  try {
    if (!KEYS.POLYGON) return res.status(400).json({ error: 'Polygon key not configured on server.' });
    const sym = String(req.params.symbol||"").toUpperCase().trim();
    if (!/^[A-Z]{1,6}$/.test(sym)) return res.status(400).json({ error: "Invalid ticker symbol." });
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
    res.status(500).json({ error: 'Server error fetching bars' });
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
    const sym = String(req.params.symbol||"").toUpperCase().trim();
    if (!/^[A-Z]{1,6}$/.test(sym)) return res.status(400).json({ error: "Invalid ticker symbol." });
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
    res.status(500).json({ error: 'Server error computing signal' });
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
    res.status(500).json({ error: 'Server error fetching account' });
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
    res.status(500).json({ error: 'Server error fetching positions' });
  }
});

app.post('/api/order', orderLimiter, async (req, res) => {
  try {
    const { mode = 'paper', symbol, notional, qty, side = 'buy', type = 'market', time_in_force = 'day', take_profit, stop_loss } = req.body;
    const a = alpaca(mode === 'live' ? 'live' : 'paper');
    if (!a.key) return res.status(400).json({ error: `Alpaca ${mode} keys not configured on server.` });
    if (!symbol) return res.status(400).json({ error: 'Missing symbol.' });
    // Validate symbol format (1-6 letters) so junk can't be forwarded to Alpaca.
    const sym = String(symbol).toUpperCase().trim();
    if (!/^[A-Z]{1,6}$/.test(sym)) return res.status(400).json({ error: 'Invalid ticker symbol.' });
    // Whitelist side and type.
    const sideOk = (side === 'buy' || side === 'sell') ? side : 'buy';
    const typeOk = ['market','limit','stop','stop_limit'].includes(type) ? type : 'market';
    // Bound dollar/share amounts to sane ranges.
    if (notional != null && notional !== '') {
      const n = parseFloat(notional);
      if (isNaN(n) || n <= 0 || n > 1000000) return res.status(400).json({ error: 'Order amount out of range.' });
    }
    if (qty != null && qty !== '') {
      const q = parseFloat(qty);
      if (isNaN(q) || q <= 0 || q > 100000) return res.status(400).json({ error: 'Share quantity out of range.' });
    }

    const order = { symbol: sym, side: sideOk, type: typeOk };
    const round2 = v => Math.round(parseFloat(v) * 100) / 100;
    const hasExit = (take_profit != null && take_profit !== '') || (stop_loss != null && stop_loss !== '');

    if (hasExit) {
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
      order.time_in_force = (time_in_force === 'gtc' ? 'gtc' : 'day');
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
    if (d.code) return res.status(400).json({ error: d.message || 'Alpaca order error' });
    res.json({ success: true, order: { id: d.id, status: d.status, symbol: d.symbol, side: d.side, notional: d.notional, qty: d.qty, order_class: d.order_class, legs: d.legs ? d.legs.length : 0 } });
  } catch (e) {
    console.error('order error:', e.message);
    res.status(500).json({ error: 'Server error placing order.' });
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
    res.status(500).json({ error: 'Server error fetching clock' });
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
    res.status(500).json({ error: 'Server error fetching closed orders' });
  }
});

// ═══════════════════════════════════════════════════════════
//  AI ANALYSIS — ANTHROPIC (VAULT / APEX / CIPHER)
//  POST /api/ai  { system, prompt, max_tokens }
// ═══════════════════════════════════════════════════════════
app.post('/api/ai', aiRateLimit, async (req, res) => {
  try {
    if (!KEYS.ANTHROPIC) return res.status(400).json({ error: 'Anthropic key not configured on server.' });
    let { system = '', prompt = '', max_tokens = 1200 } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt.' });

    // Hard caps so a malicious caller can't drain tokens with a giant request.
    max_tokens = Math.min(Math.max(parseInt(max_tokens) || 1200, 1), 4000);
    if (typeof prompt !== 'string') prompt = String(prompt);
    if (typeof system !== 'string') system = String(system);
    if (prompt.length > 12000) prompt = prompt.slice(0, 12000);
    if (system.length > 6000) system = system.slice(0, 6000);

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
    res.status(500).json({ error: 'Server error calling AI' });
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
    res.status(500).json({ error: 'Server error fetching news' });
  }
});

// ═══════════════════════════════════════════════════════════
//  DATABASE + AUTHENTICATION  (VAULT secure storage)
//  - PostgreSQL on Render (encrypted at rest automatically)
//  - Passwords hashed with bcrypt (never stored in plain text)
//  - Session tokens for login state
//  - EVERY data query scoped to the logged-in account's id
//    so one account can never read or change another's rows.
// ═══════════════════════════════════════════════════════════
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_ENABLED = !!process.env.DATABASE_URL;
const pool = DB_ENABLED
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Render managed Postgres
    })
  : null;

// Create tables on boot if they don't exist yet.
async function initDb() {
  if (!DB_ENABLED) { console.log('DB: DATABASE_URL not set — auth/storage disabled until added'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'client',     -- 'admin' (you) or 'client'
        company TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      -- All business data carries an owner_id = the account that owns it.
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT, company TEXT, email TEXT, phone TEXT,
        address TEXT, website TEXT, rating REAL, reviews INTEGER,
        status TEXT DEFAULT 'new', notes TEXT,
        score INTEGER, hot BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS emails (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        to_addr TEXT, subject TEXT, body TEXT,
        sent_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        title TEXT, notes TEXT,
        start_at TIMESTAMPTZ, end_at TIMESTAMPTZ,
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);
      CREATE INDEX IF NOT EXISTS idx_emails_owner ON emails(owner_id);
      CREATE INDEX IF NOT EXISTS idx_events_owner ON events(owner_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
    `);
    console.log('DB: tables ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

// ---- session helpers ----
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function validEmail(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200; }
// Cap any string field so a caller can't store oversized rows.
function cap(v, n){ if (v === undefined || v === null) return null; return String(v).slice(0, n); }
function capNum(v, min, max){ const x = parseFloat(v); if (isNaN(x)) return null; return Math.min(Math.max(x, min), max); }

// Periodically delete expired sessions so the table can't grow forever.
if (DB_ENABLED) {
  setInterval(() => {
    pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(()=>{});
  }, 60 * 60 * 1000); // hourly
}

async function accountFromReq(req) {
  if (!DB_ENABLED) return null;
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
  if (!token) return null;
  const r = await pool.query(
    `SELECT a.id, a.email, a.name, a.role, a.company
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token = $1 AND s.expires_at > now()`, [token]);
  return r.rows[0] || null;
}

// Middleware: require a valid logged-in account
async function requireAuth(req, res, next) {
  if (!DB_ENABLED) return res.status(503).json({ error: 'Database not configured on server yet.' });
  try {
    const acct = await accountFromReq(req);
    if (!acct) return res.status(401).json({ error: 'Not signed in.' });
    req.account = acct;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

// ═══ AUTH ENDPOINTS ═══

// Sign up a new account (defaults to client role)
app.post('/api/auth/signup', makeLimiter(8, 60*60*1000, 'Too many signups from this network. Please wait.'), async (req, res) => {
  if (!DB_ENABLED) return res.status(503).json({ error: 'Database not configured on server yet.' });
  try {
    let { email, password, name, company } = req.body;
    email = String(email || '').toLowerCase().trim();
    password = String(password || '');
    name = name ? String(name).slice(0, 120) : null;
    company = company ? String(company).slice(0, 160) : null;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (email.length > 200) return res.status(400).json({ error: 'Email too long.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (password.length > 200) return res.status(400).json({ error: 'Password too long (max 200).' });
    const exists = await pool.query('SELECT id FROM accounts WHERE email=$1', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'An account with that email already exists.' });
    const hash = await bcrypt.hash(password, 12);
    const ins = await pool.query(
      `INSERT INTO accounts (email, password_hash, name, company, role)
       VALUES ($1,$2,$3,$4,'client') RETURNING id, email, name, role, company`,
      [email, hash, name, company]);
    const acct = ins.rows[0];
    const token = newToken();
    await pool.query(`INSERT INTO sessions (token, account_id, expires_at) VALUES ($1,$2, now() + interval '30 days')`, [token, acct.id]);
    res.json({ token, account: acct });
  } catch (e) {
    console.error('signup error:', e.message);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// Log in
app.post('/api/auth/login', makeLimiter(10, 15*60*1000, 'Too many login attempts. Please wait 15 minutes.'), async (req, res) => {
  if (!DB_ENABLED) return res.status(503).json({ error: 'Database not configured on server yet.' });
  try {
    let { email, password } = req.body;
    email = String(email || '').toLowerCase().trim();
    password = String(password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    if (password.length > 200) return res.status(401).json({ error: 'Invalid email or password.' });
    const r = await pool.query('SELECT * FROM accounts WHERE email=$1', [email]);
    const acct = r.rows[0];
    if (!acct) return res.status(401).json({ error: 'Invalid email or password.' });
    const ok = await bcrypt.compare(password, acct.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
    const token = newToken();
    await pool.query(`INSERT INTO sessions (token, account_id, expires_at) VALUES ($1,$2, now() + interval '30 days')`, [token, acct.id]);
    res.json({ token, account: { id: acct.id, email: acct.email, name: acct.name, role: acct.role, company: acct.company } });
  } catch (e) {
    console.error('login error:', e.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Who am I (validate token)
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ account: req.account });
});

// Log out (kill this token)
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token) await pool.query('DELETE FROM sessions WHERE token=$1', [token]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Logout failed' }); }
});

// ═══ DATA ENDPOINTS — every query scoped to req.account.id ═══

// LEADS
app.get('/api/db/leads', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM leads WHERE owner_id=$1 ORDER BY created_at DESC', [req.account.id]);
    res.json({ leads: r.rows });
  } catch (e) { res.status(500).json({ error: 'Could not load leads' }); }
});
app.post('/api/db/leads', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO leads (owner_id,name,company,email,phone,address,website,rating,reviews,status,notes,score,hot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.account.id, cap(b.name,200), cap(b.company,200), cap(b.email,200), cap(b.phone,50),
       cap(b.address,300), cap(b.website,300), capNum(b.rating,0,5), capNum(b.reviews,0,1e7),
       cap(b.status,30)||'new', cap(b.notes,5000), capNum(b.score,0,100), !!b.hot]);
    res.json({ lead: r.rows[0] });
  } catch (e) { console.error('lead save:', e.message); res.status(500).json({ error: 'Could not save lead.' }); }
});
app.put('/api/db/leads/:id', requireAuth, async (req, res) => {
  try {
    const { status, notes, name, company, email, phone } = req.body;
    // owner_id in WHERE guarantees you can only edit your own rows
    const r = await pool.query(
      `UPDATE leads SET
         status=COALESCE($3,status), notes=COALESCE($4,notes), name=COALESCE($5,name),
         company=COALESCE($6,company), email=COALESCE($7,email), phone=COALESCE($8,phone)
       WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [req.params.id, req.account.id, status, notes, name, company, email, phone]);
    if (!r.rows.length) return res.status(404).json({ error: 'Lead not found.' });
    res.json({ lead: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Could not update lead' }); }
});
app.delete('/api/db/leads/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id=$1 AND owner_id=$2', [req.params.id, req.account.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not delete lead' }); }
});

// EMAIL HISTORY
app.get('/api/db/emails', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM emails WHERE owner_id=$1 ORDER BY sent_at DESC', [req.account.id]);
    res.json({ emails: r.rows });
  } catch (e) { res.status(500).json({ error: 'Could not load emails' }); }
});
app.post('/api/db/emails', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO emails (owner_id, lead_id, to_addr, subject, body) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.account.id, b.lead_id||null, cap(b.to_addr,200), cap(b.subject,300), cap(b.body,20000)]);
    res.json({ email: r.rows[0] });
  } catch (e) { console.error('email save:', e.message); res.status(500).json({ error: 'Could not save email.' }); }
});

// CALENDAR EVENTS
app.get('/api/db/events', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM events WHERE owner_id=$1 ORDER BY start_at ASC', [req.account.id]);
    res.json({ events: r.rows });
  } catch (e) { res.status(500).json({ error: 'Could not load events' }); }
});
app.post('/api/db/events', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO events (owner_id, title, notes, start_at, end_at, lead_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.account.id, cap(b.title,200), cap(b.notes,5000), b.start_at||null, b.end_at||null, b.lead_id||null]);
    res.json({ event: r.rows[0] });
  } catch (e) { console.error('event save:', e.message); res.status(500).json({ error: 'Could not save event.' }); }
});
app.delete('/api/db/events/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM events WHERE id=$1 AND owner_id=$2', [req.params.id, req.account.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not delete event' }); }
});

// ADMIN ONLY — you can list client accounts you manage
app.get('/api/admin/clients', requireAuth, async (req, res) => {
  try {
    if (req.account.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    const r = await pool.query(`SELECT id, email, name, company, created_at FROM accounts WHERE role='client' ORDER BY created_at DESC`);
    res.json({ clients: r.rows });
  } catch (e) { res.status(500).json({ error: 'Could not load clients' }); }
});

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
initDb().finally(() => {
  app.listen(PORT, () => {
    console.log(`EMPIRE SERVER running on port ${PORT}`);
  });
});
