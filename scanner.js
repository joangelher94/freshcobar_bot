// Fomo signal scanner — DexScreener + GMGN.
// ALERTS ONLY. This script never trades and never touches a wallet key.
// You read the alert, then decide yourself whether to buy in the Fomo app.

const fs = require('fs');
const { execFileSync } = require('child_process');

// ---------- Your rules (edit these) ----------
const CFG = {
  minLiquidityUsd: 20000,     // skip thin pools that are easy to rug or move
  minVolume1hUsd: 25000,      // needs real trading activity in the last hour
  minMarketCapUsd: 50000,
  maxMarketCapUsd: 5000000,   // memecoin range; raise if you want bigger coins
  minAgeMinutes: 30,          // skip brand-new launches (most die in minutes)
  maxAgeHours: 72,
  minBuySellRatio1h: 1.2,     // more buys than sells in the last hour
  maxPriceChange1hPct: 300,   // skip coins that already went vertical (chasing)
  requireSocials: true,       // must have an X/Twitter or Telegram link
  maxTop10HolderPct: 30,      // GMGN: top 10 wallets hold at most this %
  maxRugRatio: 0.3,           // GMGN: 0–1 rug risk score
  maxRugcheckScore: 50,       // RugCheck: 0–100, higher = riskier
  requireRugcheck: true,      // skip coins RugCheck can't check
  maxAlertsPerRun: 5,
  seenDays: 3,                // don't re-alert the same coin for this long
  takeProfitMultiple: 2,      // follow-up ping when a coin hits 2x the alert price
  stopLossPct: -30,           // follow-up ping when a coin drops 30% from the alert price
  followUpHours: 48,          // watch each alerted coin for this long
};
// ---------------------------------------------

const DS = 'https://api.dexscreener.com';
const SEEN_FILE = 'seen.json';

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function loadSeen() {
  try {
    const seen = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    const cutoff = Date.now() - CFG.seenDays * 864e5;
    for (const [k, t] of Object.entries(seen)) if (t < cutoff) delete seen[k];
    return seen;
  } catch {
    return {};
  }
}

// 1) Collect fresh Solana token addresses from DexScreener feeds.
async function getCandidates() {
  const feeds = [
    '/token-profiles/latest/v1',
    '/token-boosts/latest/v1',
    '/token-boosts/top/v1',
    '/community-takeovers/latest/v1',
  ];
  const addrs = new Set();
  for (const f of feeds) {
    try {
      const data = await getJson(DS + f);
      const list = Array.isArray(data) ? data : [data];
      for (const t of list) {
        if (t && t.chainId === 'solana' && t.tokenAddress) addrs.add(t.tokenAddress);
      }
    } catch (e) {
      console.log(`Feed failed ${f}: ${e.message}`);
    }
  }
  return [...addrs];
}

// 2) Get market data (best pool per token), 30 addresses per request.
async function getPairs(addrs) {
  const best = new Map();
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    try {
      const pairs = await getJson(`${DS}/tokens/v1/solana/${chunk.join(',')}`);
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const a = p?.baseToken?.address;
        if (!a || !chunk.includes(a)) continue;
        const liq = p?.liquidity?.usd ?? 0;
        if (!best.has(a) || liq > (best.get(a)?.liquidity?.usd ?? 0)) best.set(a, p);
      }
    } catch (e) {
      console.log(`Pairs failed: ${e.message}`);
    }
  }
  return best;
}

// 3) Market filter. Returns a reason string if rejected, or null if it passes.
function marketReject(p) {
  const liq = p?.liquidity?.usd ?? 0;
  const vol = p?.volume?.h1 ?? 0;
  const mc = p?.marketCap ?? p?.fdv ?? 0;
  const buys = p?.txns?.h1?.buys ?? 0;
  const sells = p?.txns?.h1?.sells ?? 0;
  const ch = p?.priceChange?.h1 ?? 0;
  const ageMin = p?.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : null;

  if (liq < CFG.minLiquidityUsd) return 'low liquidity';
  if (vol < CFG.minVolume1hUsd) return 'low volume';
  if (mc < CFG.minMarketCapUsd || mc > CFG.maxMarketCapUsd) return 'market cap out of range';
  if (ageMin === null) return 'unknown age';
  if (ageMin < CFG.minAgeMinutes) return 'too new';
  if (ageMin > CFG.maxAgeHours * 60) return 'too old';
  if (sells > 0 ? buys / sells < CFG.minBuySellRatio1h : buys < 10) return 'weak buying';
  if (ch > CFG.maxPriceChange1hPct) return 'already pumped';
  if (CFG.requireSocials && !socialsOf(p).length) return 'no X or Telegram';
  return null;
}

// X/Twitter and Telegram links from the DexScreener pair info.
function socialsOf(p) {
  const list = Array.isArray(p?.info?.socials) ? p.info.socials : [];
  const out = [];
  for (const s of list) {
    const type = String(s?.type || '').toLowerCase();
    const url = String(s?.url || '');
    if (type === 'twitter' || type === 'x' || /(^|\/\/)(www\.)?(x|twitter)\.com\//i.test(url)) out.push('X');
    else if (type === 'telegram' || /(^|\/\/)t\.me\//i.test(url)) out.push('Telegram');
  }
  return [...new Set(out)];
}

// 4) GMGN security check (optional — skipped if no API key is set).
const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'yes';
const falsy = (v) => v === false || v === 0 || v === '0' || v === 'no';

let gmgnLoggedSample = false;
function gmgnSecurity(address) {
  if (!process.env.GMGN_API_KEY) return null;
  try {
    const out = execFileSync(
      'gmgn-cli',
      ['token', 'security', '--chain', 'sol', '--address', address, '--raw'],
      { encoding: 'utf8', timeout: 60000 }
    );
    const json = JSON.parse(out);
    const d = json?.data ?? json;
    if (!gmgnLoggedSample) {
      // Printed once per run so the field names can be checked in the logs.
      console.log('GMGN sample:', JSON.stringify(d).slice(0, 1500));
      gmgnLoggedSample = true;
    }
    let top10 = pick(d, 'top_10_holder_rate', 'top10_holder_rate');
    if (top10 !== undefined) top10 = Number(top10) <= 1 ? Number(top10) * 100 : Number(top10);
    return {
      honeypot: pick(d, 'is_honeypot', 'honeypot'),
      rugRatio: pick(d, 'rug_ratio'),
      top10,
      mintRenounced: pick(d, 'renounced_mint'),
      freezeRenounced: pick(d, 'renounced_freeze_account'),
    };
  } catch (e) {
    console.log(`GMGN failed for ${address}: ${String(e.message).slice(0, 300)}`);
    return null;
  }
}

function securityReject(s) {
  if (!s) return null;
  if (truthy(s.honeypot)) return 'honeypot';
  if (s.rugRatio !== undefined && Number(s.rugRatio) > CFG.maxRugRatio) return 'high rug ratio';
  if (s.top10 !== undefined && s.top10 > CFG.maxTop10HolderPct) return 'top 10 hold too much';
  if (falsy(s.mintRenounced)) return 'mint not renounced';
  if (falsy(s.freezeRenounced)) return 'freeze not renounced';
  return null;
}

// 4b) RugCheck safety check (free, no key needed).
let rcLoggedSample = false;
async function rugcheck(address) {
  try {
    const d = await getJson(`https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`);
    if (!rcLoggedSample) {
      // Printed once per run so the fields can be checked in the logs.
      console.log('RugCheck sample:', JSON.stringify(d).slice(0, 1500));
      rcLoggedSample = true;
    }
    const risks = Array.isArray(d?.risks) ? d.risks : [];
    return {
      score: d?.score_normalised,
      lpLockedPct: d?.lpLockedPct,
      dangers: risks.filter((r) => String(r?.level).toLowerCase() === 'danger').map((r) => r.name),
      warnings: risks.filter((r) => String(r?.level).toLowerCase() === 'warn').map((r) => r.name),
    };
  } catch (e) {
    console.log(`RugCheck failed for ${address}: ${e.message}`);
    return null;
  }
}

function rugcheckReject(rc) {
  if (!rc) return CFG.requireRugcheck ? 'RugCheck unavailable' : null;
  if (rc.dangers.length) return 'RugCheck danger: ' + rc.dangers.join(', ');
  const auth = rc.warnings.find((n) => /mint authority|freeze authority/i.test(n || ''));
  if (auth) return 'RugCheck: ' + auth;
  if (rc.score !== undefined && Number(rc.score) > CFG.maxRugcheckScore) return 'RugCheck score too high';
  return null;
}

const fmtRc = (rc) => {
  if (!rc) return 'RugCheck: not checked';
  const lp = rc.lpLockedPct !== undefined ? `${Number(rc.lpLockedPct).toFixed(0)}%` : '?';
  const warn = rc.warnings.length ? `\nWarnings: ${rc.warnings.join(', ')}` : '';
  return `RugCheck risk: ${rc.score ?? '?'} (lower = safer) | LP locked: ${lp}${warn}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 5) Simple 0–100 score so the best signals come first.
function score(p) {
  const buys = p?.txns?.h1?.buys ?? 0;
  const sells = p?.txns?.h1?.sells ?? 1;
  const ratio = Math.min(buys / Math.max(sells, 1), 3) / 3;               // buy pressure
  const turnover = Math.min((p?.volume?.h1 ?? 0) / Math.max(p?.liquidity?.usd ?? 1, 1), 3) / 3;
  const ch = p?.priceChange?.h1 ?? 0;
  const momentum = ch <= 0 ? 0 : ch >= 150 ? 0.4 : Math.min(ch / 60, 1); // up, but not too late
  return Math.round(100 * (0.4 * ratio + 0.35 * turnover + 0.25 * momentum));
}

const usd = (n) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n || 0)}`;
const fmtSec = (s) => {
  if (!s) return 'GMGN: not checked';
  const show = (v) => (v === undefined ? '?' : truthy(v) ? 'yes' : falsy(v) ? 'no' : String(v));
  return [
    `Honeypot: ${show(s.honeypot)}`,
    `Rug ratio: ${s.rugRatio ?? '?'}`,
    `Top 10 hold: ${s.top10 !== undefined ? s.top10.toFixed(1) + '%' : '?'}`,
    `Mint renounced: ${show(s.mintRenounced)} | Freeze renounced: ${show(s.freezeRenounced)}`,
  ].join('\n');
};

function alertText(p, s, sc, rc) {
  const a = p.baseToken.address;
  const ageH = ((Date.now() - p.pairCreatedAt) / 36e5).toFixed(1);
  return [
    `🔔 ${p.baseToken.symbol} (${p.baseToken.name}) — score ${sc}/100`,
    `MC ${usd(p.marketCap ?? p.fdv)} | Liq ${usd(p.liquidity?.usd)} | Vol 1h ${usd(p.volume?.h1)}`,
    `1h: ${p.priceChange?.h1 ?? 0}% | Buys/Sells 1h: ${p.txns?.h1?.buys}/${p.txns?.h1?.sells} | Age ${ageH}h`,
    `Socials: ${socialsOf(p).join(' + ') || 'none'}`,
    fmtRc(rc),
    ...(s ? [fmtSec(s)] : []),
    ``,
    `Contract (paste in Fomo search):`,
    a,
    `Chart: ${p.url}`,
    `GMGN: https://gmgn.ai/sol/token/${a}`,
    ``,
    `Signal only — check it yourself before buying.`,
  ].join('\n');
}

async function sendTelegram(text) {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  const c = process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) {
    console.log('--- (no Telegram set up) ---\n' + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: c, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) console.log(`Telegram error ${res.status}: ${await res.text()}`);
}

// ---------- Paper-trade tracker + daily/weekly reports ----------
const TRACK_FILE = 'tracker.json';
const CHECKS = { h1: 1, h4: 4, h24: 24 }; // hours after the alert
const REPORT_HOUR_ET = 21;                // daily message after 9pm Eastern
const WEEKLY_DAY = 'Sun';                 // weekly report on Sunday night

function loadTracker() {
  try {
    const t = JSON.parse(fs.readFileSync(TRACK_FILE, 'utf8'));
    return { alerts: [], day: null, weekSent: null, ...t };
  } catch {
    return { alerts: [], day: null, weekSent: null };
  }
}

function nowET() {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const o = {};
  for (const part of f.formatToParts(new Date())) o[part.type] = part.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24, weekday: o.weekday };
}

function fmtPrice(n) {
  if (!(n > 0)) return '?';
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

function followUpText(a, p, price, up) {
  const ch = (price / a.price - 1) * 100;
  return [
    up
      ? `🚀 ${a.symbol} is up ${pct(ch)} since the alert (${(price / a.price).toFixed(1)}x)`
      : `🔻 ${a.symbol} is down ${Math.abs(ch).toFixed(1)}% since the alert`,
    `Alert price ${fmtPrice(a.price)} → now ${fmtPrice(price)}`,
    up
      ? 'If you bought, think about taking some profit.'
      : 'If you bought, think about cutting it before it falls further.',
    '',
    a.addr,
    `Chart: ${p?.url || `https://dexscreener.com/solana/${a.addr}`}`,
  ].join('\n');
}

// Price checks (1h / 4h / 24h) plus take-profit / stop-loss follow-up alerts.
async function updateTracker(tr) {
  const now = Date.now();
  const isDue = (a, k, h) => a.checks[k] === undefined && now - a.t >= h * 36e5;
  const watching = (a) => now - a.t < CFG.followUpHours * 36e5;
  const active = tr.alerts.filter(
    (a) => watching(a) || Object.entries(CHECKS).some(([k, h]) => isDue(a, k, h))
  );
  if (!active.length) return;
  const pairs = await getPairs([...new Set(active.map((a) => a.addr))]);
  for (const a of active) {
    const p = pairs.get(a.addr);
    const price = Number(p?.priceUsd);
    for (const [k, h] of Object.entries(CHECKS)) {
      if (!isDue(a, k, h)) continue;
      if (price > 0) a.checks[k] = +((price / a.price - 1) * 100).toFixed(1);
      else if (now - a.t > (h + 6) * 36e5) a.checks[k] = -100; // no price for 6h+: treat as dead
    }
    if (!(price > 0) || !watching(a)) continue;
    a.flags = a.flags || {};
    a.peak = Math.max(a.peak || 0, price / a.price);
    if (!a.flags.tp && price >= a.price * CFG.takeProfitMultiple) {
      await sendTelegram(followUpText(a, p, price, true));
      a.flags.tp = true;
    }
    if (!a.flags.sl && price <= a.price * (1 + CFG.stopLossPct / 100)) {
      await sendTelegram(followUpText(a, p, price, false));
      a.flags.sl = true;
    }
  }
}

const pct = (v) => (v === undefined ? '?' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const avgOf = (list, k) => {
  const v = list.map((a) => a.checks[k]).filter((x) => x !== undefined);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : undefined;
};
const median = (nums) => {
  if (!nums.length) return undefined;
  const s = [...nums].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function weeklyReport(tr) {
  const weekAgo = Date.now() - 7 * 864e5;
  const done = tr.alerts.filter((a) => a.t >= weekAgo && a.checks.h24 !== undefined);
  if (!done.length) return '📊 Weekly paper-trade report\nNo finished alerts yet (each one needs 24h).';
  const up = (list) => list.filter((a) => a.checks.h24 > 0).length;
  const group = (name, list) =>
    list.length
      ? `${name}: ${list.length} alerts, ${Math.round((100 * up(list)) / list.length)}% up, avg ${pct(avgOf(list, 'h24'))}`
      : `${name}: none`;
  const byGain = [...done].sort((x, y) => y.checks.h24 - x.checks.h24);
  const best = byGain[0];
  const worst = byGain[byGain.length - 1];
  return [
    '📊 Weekly paper-trade report',
    `Alerts tracked: ${done.length}`,
    `Up after 24h: ${up(done)}/${done.length} (${Math.round((100 * up(done)) / done.length)}%)`,
    `Average: 1h ${pct(avgOf(done, 'h1'))} | 4h ${pct(avgOf(done, 'h4'))} | 24h ${pct(avgOf(done, 'h24'))}`,
    `Median 24h: ${pct(median(done.map((a) => a.checks.h24)))}`,
    `Best: ${best.symbol} ${pct(best.checks.h24)} | Worst: ${worst.symbol} ${pct(worst.checks.h24)}`,
    `Hit ${CFG.takeProfitMultiple}x at some point: ${done.filter((a) => a.flags?.tp).length} | ` +
      `Fell ${-CFG.stopLossPct}% at some point: ${done.filter((a) => a.flags?.sl).length}`,
    '',
    'Which alerts did better:',
    group('Score 60+', done.filter((a) => a.score >= 60)),
    group('Score under 60', done.filter((a) => a.score < 60)),
    group('RugCheck 0–20', done.filter((a) => a.rc !== undefined && a.rc <= 20)),
    group('RugCheck 21+', done.filter((a) => a.rc !== undefined && a.rc > 20)),
    '',
    'Uses the price at alert time. Real buys get worse prices plus fees.',
  ].join('\n');
}

function dailyText(day, tr) {
  const tracking = tr.alerts.filter((a) => a.checks.h24 === undefined).length;
  return [
    `✅ Scanner running — ${day.date}`,
    `Scans: ${day.runs} | Coins checked: ${day.checked} | Alerts: ${day.alerts}`,
    `Coins still being tracked: ${tracking}`,
  ].join('\n');
}

async function reports(tr, runStats) {
  const et = nowET();
  // New day: send yesterday's summary if it never went out, then start fresh.
  if (!tr.day || tr.day.date !== et.date) {
    if (tr.day && !tr.day.sent) await sendTelegram(dailyText(tr.day, tr));
    tr.day = { date: et.date, runs: 0, checked: 0, alerts: 0, sent: false };
  }
  tr.day.runs += 1;
  tr.day.checked += runStats.checked;
  tr.day.alerts += runStats.alerts;

  if (et.hour >= REPORT_HOUR_ET && !tr.day.sent) {
    await sendTelegram(dailyText(tr.day, tr));
    tr.day.sent = true;
    if (et.weekday === WEEKLY_DAY && tr.weekSent !== et.date) {
      await sendTelegram(weeklyReport(tr));
      tr.weekSent = et.date;
    }
  }
}
// ----------------------------------------------------------------

async function main() {
  const seen = loadSeen();
  const tr = loadTracker();
  tr.alerts = tr.alerts.filter((a) => Date.now() - a.t < 8 * 864e5); // keep ~1 week
  try {
    await updateTracker(tr);
  } catch (e) {
    console.log(`Tracker update failed: ${e.message}`);
  }

  const candidates = (await getCandidates()).filter((a) => !seen[a]);
  console.log(`Candidates (new): ${candidates.length}`);

  const pairs = await getPairs(candidates);
  const passed = [];
  const reasons = {};
  for (const [a, p] of pairs) {
    const r = marketReject(p);
    if (r) reasons[r] = (reasons[r] || 0) + 1;
    else passed.push({ a, p, sc: score(p) });
  }
  console.log('Market rejects:', JSON.stringify(reasons));
  passed.sort((x, y) => y.sc - x.sc);

  let sent = 0;
  for (const { a, p, sc } of passed) {
    if (sent >= CFG.maxAlertsPerRun) break;
    const rc = await rugcheck(a);
    await sleep(1000); // be gentle with the free RugCheck API
    const rr = rugcheckReject(rc);
    if (rr) {
      console.log(`Skip ${p.baseToken.symbol}: ${rr}`);
      if (rc) seen[a] = Date.now(); // real red flag: don't re-check
      continue;
    }
    const s = gmgnSecurity(a);
    const r = securityReject(s);
    if (r) {
      console.log(`Skip ${p.baseToken.symbol}: ${r}`);
      seen[a] = Date.now(); // security rarely improves, so don't re-check
      continue;
    }
    await sendTelegram(alertText(p, s, sc, rc));
    seen[a] = Date.now();
    sent++;
    const price = Number(p.priceUsd);
    if (price > 0) {
      tr.alerts.push({
        addr: a, symbol: p.baseToken.symbol, t: Date.now(), price,
        score: sc, rc: rc?.score, checks: {},
      });
    }
  }
  console.log(`Alerts sent: ${sent}`);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 1));

  try {
    await reports(tr, { checked: pairs.size, alerts: sent });
  } catch (e) {
    console.log(`Reports failed: ${e.message}`);
  }
  fs.writeFileSync(TRACK_FILE, JSON.stringify(tr, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
