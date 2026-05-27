/**
 * Cloudflare Pages Function — Tourism Data Proxy
 * Fetches Taiwan government open data CSV, processes it, returns JSON.
 * Endpoint: /tourism
 */

const CSV_URL =
  'https://media.taiwan.net.tw/od/01_PRD/' +
  encodeURIComponent('歷年國內主要觀光遊憩據點遊客人數月別統計.csv');

const MONTHS = ['1月','2月','3月','4月','5月','6月',
                '7月','8月','9月','10月','11月','12月'];

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
};

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const csv  = await fetchCSV(CSV_URL);
    const rows = parseCSV(csv);
    const data = aggregate(rows);
    return new Response(JSON.stringify(data), { headers: CORS });
  } catch (err) {
    console.error('[tourism] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: CORS,
    });
  }
}

/* ─────────────────────────────────────────
   CSV fetch  (uses global fetch — no https module needed)
───────────────────────────────────────── */
async function fetchCSV(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CloudflareWorker/1.0)',
      'Referer':    'https://data.gov.tw/',
      'Accept':     'text/csv,*/*',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buf   = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Strip UTF-8 BOM (0xEF 0xBB 0xBF)
  const start = (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) ? 3 : 0;
  return new TextDecoder('utf-8').decode(bytes.slice(start));
}

/* ─────────────────────────────────────────
   CSV parser (handles quoted fields)
───────────────────────────────────────── */
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV too short');

  const headers = splitLine(lines[0]);

  return lines.slice(1).map(line => {
    const vals = splitLine(line);
    const row  = {};
    headers.forEach((h, i) => { row[h.trim()] = (vals[i] ?? '').trim(); });
    return row;
  }).filter(r => r['年別'] && /^\d+$/.test(r['年別'].trim()));
}

function splitLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"')            { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
    else                       { cur += ch; }
  }
  result.push(cur);
  return result;
}

/* ─────────────────────────────────────────
   Data aggregation
───────────────────────────────────────── */
function toNum(v) {
  if (!v || /^[-－—]$/.test(v.trim())) return 0;
  const n = parseFloat(v.replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function cleanName(s) {
  return (s || '').replace(/[\n\r].*$/, '').trim();
}

function aggregate(rows) {
  const allYears   = [...new Set(rows.map(r => parseInt(r['年別'])))].filter(y => !isNaN(y));
  const latestYear = Math.max(...allYears);
  const latest     = rows.filter(r => parseInt(r['年別']) === latestYear && toNum(r['合計']) > 0);

  // county top 10
  const countyMap = {};
  for (const r of latest) {
    const name = cleanName(r['縣市']);
    if (!name || name === '未提供') continue;
    countyMap[name] = (countyMap[name] || 0) + toNum(r['合計']);
  }
  const county = Object.entries(countyMap)
    .map(([name, v]) => ({ name, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 10);

  // monthly totals
  const monthly = MONTHS.map(m => ({
    month: m,
    v: latest.reduce((s, r) => s + toNum(r[m]), 0),
  }));

  // top 5 spots
  const spotMap = {};
  for (const r of latest) {
    const spot   = (r['觀光遊憩區'] || '').trim();
    const detail = (r['細分']       || '').trim();
    const county = cleanName(r['縣市']);
    const name   = (spot === '' || spot === '-') ? detail : spot;
    if (!name || name === '-') continue;
    const key = `${name}||${county}`;
    if (!spotMap[key]) spotMap[key] = { name, county, v: 0 };
    spotMap[key].v += toNum(r['合計']);
  }
  const spots = Object.values(spotMap)
    .sort((a, b) => b.v - a.v)
    .slice(0, 5);

  // type breakdown
  const typeMap = {};
  for (const r of latest) {
    const type = (r['類型'] || '').trim();
    if (!type) continue;
    typeMap[type] = (typeMap[type] || 0) + toNum(r['合計']);
  }
  const types = Object.entries(typeMap)
    .map(([type, v]) => ({ type, v }))
    .sort((a, b) => b.v - a.v);

  // year trend
  const yearMap = {};
  for (const r of rows) {
    const y = parseInt(r['年別']);
    if (isNaN(y)) continue;
    yearMap[y] = (yearMap[y] || 0) + toNum(r['合計']);
  }
  const yearTrend = Object.entries(yearMap)
    .map(([year, v]) => ({ year: parseInt(year), v }))
    .sort((a, b) => a.year - b.year);

  const totalVisitors = monthly.reduce((s, d) => s + d.v, 0);

  return {
    year: latestYear,
    totalVisitors,
    updatedAt: new Date().toISOString(),
    county,
    monthly,
    spots,
    types,
    yearTrend,
  };
}
