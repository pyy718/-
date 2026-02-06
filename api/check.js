/* eslint-disable no-console */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stamp(d = new Date()) {
  return `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function readJson(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function extractTarget(line) {
  const urlMatch = line.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) return urlMatch[0];

  const domainMatch = line.match(/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+/i);
  if (domainMatch) return domainMatch[0];

  return null;
}

function makeCandidates(target) {
  const replaced = String(target).trim().replace(/\*/g, 'a');
  if (/^https?:\/\//i.test(replaced)) return [replaced];
  return [`https://${replaced}`, `http://${replaced}`];
}

function replaceOrAppendRate(line, rate) {
  const RATE_LABEL = '\u8fde\u901a\u7387'; // 连通率
  const re = new RegExp(`${RATE_LABEL}(\\s*)\\d+%`);
  if (re.test(line)) return line.replace(re, (_m, spaces) => `${RATE_LABEL}${spaces}${rate}%`);
  return `${line} ${RATE_LABEL}${rate}%`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOnce(url, { timeoutMs, mode }) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const status = res.status;
    let ok = false;
    if (mode === 2) ok = status === 200;
    else if (mode === 1) ok = status >= 200 && status < 400;
    else ok = Number.isFinite(status) && status > 0;
    return { ok, status, finalUrl: res.url || url };
  } catch (e) {
    return { ok: false, status: 0, finalUrl: '', error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(id);
  }
}

async function probeTarget(candidates, opts) {
  for (const url of candidates) {
    const r = await fetchOnce(url, opts);
    if (r.ok) return { ok: true, requested: url, status: r.status, finalUrl: r.finalUrl };
    // if request fails, try next candidate (https -> http)
  }
  return { ok: false };
}

async function checkTarget(candidates, { probes, retries, timeoutMs, mode }) {
  let success = 0;
  const errors = [];

  for (let i = 0; i < probes; i++) {
    let ok = false;
    let lastErr = '';

    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await probeTarget(candidates, { timeoutMs, mode });
      if (r.ok) {
        ok = true;
        break;
      }
      lastErr = r.error || 'request failed';
      if (attempt < retries) await sleep(250 + Math.floor(Math.random() * 200));
    }

    if (ok) success++;
    else errors.push(lastErr || 'request failed');
  }

  const rate = Math.round((success / probes) * 100);
  return { rate, success, fails: probes - success, errors: errors.slice(0, 3) };
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const body = await readJson(req);
    const text = String(body && body.text ? body.text : '');

    const probes = clampInt(body?.probes, 1, 10, 2);
    const concurrency = clampInt(body?.concurrency, 1, 25, 8);
    const timeoutMs = clampInt(body?.timeoutMs, 1000, 60000, 8000);
    const threshold = clampInt(body?.threshold, 0, 100, 85);
    const retries = clampInt(body?.retries, 0, 5, 1);
    // mode: 0=any http response, 1=2xx/3xx, 2=only 200
    const modeRaw = body?.mode != null ? body.mode : body?.strict;
    const mode = clampInt(modeRaw, 0, 2, 1);

    const usesCrlf = text.includes('\r\n');
    const lines = text.split(/\r?\n/);

    const lineMeta = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return { line, key: null, hasRate: false };
      const hasRate = /\u8fde\u901a\u7387\s*\d+%/.test(line);
      const target = extractTarget(trimmed);
      if (!target) return { line, key: null, hasRate };
      const candidates = makeCandidates(target);
      const key = candidates[0].toLowerCase();
      return { line, key, hasRate, target, candidates };
    });

    const targets = [];
    const keyToItem = new Map();
    for (const m of lineMeta) {
      if (!m.key || !m.candidates) continue;
      targets.push(m.key);
      if (!keyToItem.has(m.key)) keyToItem.set(m.key, { key: m.key, target: m.target, candidates: m.candidates });
    }
    const uniqueKeys = Array.from(new Set(targets));

    if (!uniqueKeys.length) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: '未发现可检测的网址/域名（请检查 txt 格式）' }));
      return;
    }
    if (uniqueKeys.length > 120) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `本版本建议 ≤100 条；当前目标数：${uniqueKeys.length}` }));
      return;
    }

    const items = uniqueKeys.map((k) => keyToItem.get(k)).filter(Boolean);

    const checked = await runPool(items, concurrency, async (it) => {
      const r = await checkTarget(it.candidates, { probes, retries, timeoutMs, mode });
      return { key: it.key, rate: r.rate, errors: r.errors, fails: r.fails, probes };
    });

    const cache = new Map();
    for (const r of checked) cache.set(r.key, r);

    const lowLines = [];
    const outLines = lineMeta.map((m) => {
      if (!m.key) return m.line;

      const r = cache.get(m.key);
      const rate = r ? r.rate : 0;
      const updated = m.hasRate ? replaceOrAppendRate(m.line, rate) : replaceOrAppendRate(m.line, rate);
      if (rate < threshold) lowLines.push(updated);
      return updated;
    });

    if (lowLines.length) {
      outLines.push('');
      outLines.push(`========== 低于${threshold}% (共${lowLines.length}条) ==========`); // keep simple
      for (const l of lowLines) outLines.push(l);
    }

    const fileName = `域名连通${stamp()}.txt`;
    const eol = usesCrlf ? '\r\n' : '\n';
    const outputText = outLines.join(eol);

    const failedTargets = checked.filter((r) => r && r.rate < 100).length;
    const stats = {
      totalLines: lines.length,
      targets: uniqueKeys.length,
      failedTargets,
      lowCount: lowLines.length,
      probes,
      concurrency,
      timeoutMs,
      threshold,
      retries,
      mode,
    };

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ fileName, outputText, stats }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  }
};
