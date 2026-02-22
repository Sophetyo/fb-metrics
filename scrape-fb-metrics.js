#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function usage() {
  console.log(`Usage:
  node scrape-fb-metrics.js --urls file.txt [--headless=true|false] [--source=direct|plugin]
  node scrape-fb-metrics.js --url "https://www.facebook.com/reel/..." [--source=direct|plugin]
  node scrape-fb-metrics.js --urls file.txt --json=true
  node scrape-fb-metrics.js --urls file.txt --storage-state=fb-session.json

Input format (file.txt): one URL per line.
You can provide either:
- reel/post/video URLs
- facebook plugin iframe/video URLs
`);
}

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const [k, v] = token.slice(2).split('=');
    args[k] = v === undefined ? true : v;
  }
  return args;
}

function sanitizeUrl(s) {
  return String(s || '')
    .trim()
    .replace(/[\\}\]]+$/g, '')
    .replace(/^[{[(]+/g, '');
}

function extractUrlsFromText(data) {
  const found = data.match(/https?:\/\/[^\s"'<>()]+/gi) || [];
  return found
    .map((u) => sanitizeUrl(u))
    .filter((u) => /^https?:\/\/(www\.)?facebook\.com\//i.test(u));
}

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function toPluginUrl(rawUrl) {
  try {
    const u = new URL(sanitizeUrl(rawUrl));
    if (u.hostname.includes('facebook.com') && u.pathname.startsWith('/plugins/video.php')) {
      return u.toString();
    }
    return `https://www.facebook.com/plugins/video.php?height=476&href=${encodeURIComponent(u.toString())}&show_text=false&width=267&t=0`;
  } catch {
    return sanitizeUrl(rawUrl);
  }
}

function toDirectUrl(rawUrl) {
  return sanitizeUrl(rawUrl);
}

function normalizeNumber(s) {
  if (!s) return null;
  let t = s.replace(/\s+/g, '').replace(',', '.').toLowerCase();
  let mult = 1;
  if (t.endsWith('k')) {
    mult = 1000;
    t = t.slice(0, -1);
  } else if (t.endsWith('m')) {
    mult = 1000000;
    t = t.slice(0, -1);
  }
  const n = Number(t);
  if (Number.isNaN(n)) return null;
  return Math.round(n * mult);
}

function findLastNumber(text) {
  const m = text.match(/(\d[\d\s.,kKmM]*)\D*$/);
  return m ? normalizeNumber(m[1]) : null;
}

function parseMetricsFromText(text) {
  const cleaned = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const normalized = cleaned.map((l) => stripDiacritics(l).toLowerCase());

  let likes = null;
  let comments = null;
  let shares = null;

  const full = normalized.join('\n');
  const c = full.match(/(\d[\d\s.,kKmM]*)\s+(commentaires?|comments?)/i);
  const p = full.match(/(\d[\d\s.,kKmM]*)\s+(partages?|shares?)/i);
  const l = full.match(/(\d[\d\s.,kKmM]*)\s+(j'?aime|likes?|reactions?)/i);
  if (c) comments = normalizeNumber(c[1]);
  if (p) shares = normalizeNumber(p[1]);
  if (l) likes = normalizeNumber(l[1]);

  const lineIdx = normalized.findIndex((l) => /(commentaires?|comments?|partages?|shares?)/i.test(l));
  const line = lineIdx >= 0 ? cleaned[lineIdx] : null;
  if (line) {
    const nums = [...line.matchAll(/\d[\d\s.,kKmM]*/g)].map((m) => normalizeNumber(m[0])).filter((n) => n !== null);
    if (nums.length >= 3) {
      likes = likes ?? nums[0];
      comments = comments ?? nums[1];
      shares = shares ?? nums[2];
    } else if (nums.length === 2) {
      comments = comments ?? nums[0];
      shares = shares ?? nums[1];
    }
  }

  if (likes === null) {
    const idx = normalized.findIndex((l) => /(commentaires?|comments?|partages?|shares?)/i.test(l));
    if (idx > 0) {
      likes = findLastNumber(cleaned[idx - 1]);
    }
  }

  // If action labels are present on the same line, extract the nearest number on the left.
  if (likes === null) {
    const likeLineIdx = normalized.findIndex((l) => /(j'?aime|likes?|reactions?)/i.test(l));
    if (likeLineIdx >= 0) likes = findLastNumber(cleaned[likeLineIdx]);
  }

  // Direct Reel pages can expose counters as 3 standalone numeric lines (likes/comments/shares).
  if (likes === null || comments === null || shares === null) {
    const nums = [];
    for (let i = 0; i < cleaned.length; i += 1) {
      if (/^\d[\d\s.,kKmM]*$/.test(cleaned[i])) {
        const n1 = normalizeNumber(cleaned[i]);
        const n2 = normalizeNumber(cleaned[i + 1] || '');
        const n3 = normalizeNumber(cleaned[i + 2] || '');
        if (n1 !== null && n2 !== null && n3 !== null) {
          nums.push([n1, n2, n3]);
        }
      }
    }
    if (nums.length > 0) {
      const [a, b, c] = nums[0];
      likes = likes ?? a;
      comments = comments ?? b;
      shares = shares ?? c;
    }
  }

  return { likes, comments, shares };
}

function parseMetricsFromHtml(html) {
  const pick = (patterns) => {
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) {
        const n = normalizeNumber(m[1]);
        if (n !== null) return n;
      }
    }
    return null;
  };

  const likes = pick([
    /"reaction_count"\s*:\s*"?(\d[\d.,kKmM]*)"?/i,
    /"feedback_reaction_count"\s*:\s*"?(\d[\d.,kKmM]*)"?/i,
    /"like_count"\s*:\s*"?(\d[\d.,kKmM]*)"?/i,
  ]);

  const comments = pick([
    /"comment_count"\s*:\s*"?(\d[\d.,kKmM]*)"?/i,
    /"total_comment_count"\s*:\s*"?(\d[\d.,kKmM]*)"?/i,
  ]);

  const shares = pick([
    /"share_count"\s*:\s*"?(\d[\d.,kKmM]*)"?/i,
    /"total_share_count"\s*:\s*"?(\d[\d.,kKmM]*)"?/i,
  ]);

  return { likes, comments, shares };
}

function mergeMetrics(primary, secondary) {
  return {
    likes: primary.likes ?? secondary.likes ?? null,
    comments: primary.comments ?? secondary.comments ?? null,
    shares: primary.shares ?? secondary.shares ?? null,
  };
}

function pickSourceUrl(inputUrl, source) {
  return source === 'plugin' ? toPluginUrl(inputUrl) : toDirectUrl(inputUrl);
}

async function scrapeOne(page, inputUrl, debug, source) {
  const url = pickSourceUrl(inputUrl, source);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  const text = await page.evaluate(() => document.body?.innerText || '');
  const html = await page.content();
  const byText = parseMetricsFromText(text);
  // HTML extraction is only used in plugin mode because direct pages are too noisy in script blobs.
  const byHtml = source === 'plugin' ? parseMetricsFromHtml(html) : { likes: null, comments: null, shares: null };
  const metrics = mergeMetrics(byText, byHtml);

  if (debug) {
    const id = (inputUrl.match(/\/(reel|videos?)\/(\d+)/i)?.[2] || Date.now().toString());
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    fs.writeFileSync(path.resolve(process.cwd(), `debug-${safe}.txt`), text, 'utf8');
    fs.writeFileSync(path.resolve(process.cwd(), `debug-${safe}.html`), html, 'utf8');
  }

  return {
    inputUrl,
    scrapedUrl: url,
    ...metrics,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url && !args.urls) {
    usage();
    process.exit(1);
  }

  let urls = [];
  if (args.url) urls.push(sanitizeUrl(args.url));
  if (args.urls) {
    const p = path.resolve(process.cwd(), String(args.urls));
    const data = fs.readFileSync(p, 'utf8');
    urls.push(...extractUrlsFromText(data));
  }
  urls = [...new Set(urls)];
  const debug = String(args.debug ?? 'false').toLowerCase() === 'true';
  const source = String(args.source ?? 'direct').toLowerCase() === 'plugin' ? 'plugin' : 'direct';
  const asJson = String(args.json ?? 'false').toLowerCase() === 'true';
  const storageStateArg = args['storage-state'] ? path.resolve(process.cwd(), String(args['storage-state'])) : null;

  const headless = String(args.headless ?? 'false').toLowerCase() === 'true';

  const browser = await chromium.launch({ headless });
  const contextOptions = { locale: 'fr-FR' };
  if (storageStateArg && fs.existsSync(storageStateArg)) {
    contextOptions.storageState = storageStateArg;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const out = [];
  for (const u of urls) {
    try {
      const row = await scrapeOne(page, u, debug, source);
      out.push(row);
      if (!asJson) console.log(`[OK] ${u}`);
    } catch (e) {
      out.push({ inputUrl: u, error: String(e.message || e) });
      if (!asJson) console.log(`[ERR] ${u} -> ${String(e.message || e)}`);
    }
  }

  await context.close();
  await browser.close();

  const totals = out.reduce((acc, r) => {
    acc.likes += Number.isFinite(r.likes) ? r.likes : 0;
    acc.comments += Number.isFinite(r.comments) ? r.comments : 0;
    acc.shares += Number.isFinite(r.shares) ? r.shares : 0;
    return acc;
  }, { likes: 0, comments: 0, shares: 0 });
  if (asJson) {
    console.log(JSON.stringify({ results: out, totals }, null, 2));
    return;
  }

  console.log('\nResults:');
  console.table(out.map((r) => ({
    url: r.inputUrl,
    likes: r.likes ?? 'N/A',
    comments: r.comments ?? 'N/A',
    shares: r.shares ?? 'N/A',
    error: r.error || '',
  })));
  console.log(`Totals -> likes: ${totals.likes}, comments: ${totals.comments}, shares: ${totals.shares}`);
  const allNA = out.length > 0 && out.every((r) => !Number.isFinite(r.likes) && !Number.isFinite(r.comments) && !Number.isFinite(r.shares));
  if (allNA && source === 'direct') {
    console.log('\nHint: if Facebook asks login/consent, connect in the opened browser tab and relaunch with --headless=false.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
