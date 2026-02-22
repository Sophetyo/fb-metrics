#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 3210);
const ROOT = __dirname;
const SCRAPER = path.join(ROOT, 'scrape-fb-metrics.js');

const VIDEOS = [
  { id: 1, title: "lycée agricole d'Yvetot", url: 'https://www.facebook.com/reel/1167958628558423' },
  { id: 2, title: 'lycée La Salle St Antoine', url: 'https://www.facebook.com/reel/1406510241168380' },
  { id: 3, title: 'Lycée Nature (85)', url: 'https://www.facebook.com/reel/1201528905398420' },
  { id: 4, title: "l'Agricampus de Laval", url: 'https://www.facebook.com/reel/1704222193876563' },
  { id: 5, title: 'lycée de Melle (79)', url: 'https://www.facebook.com/reel/865110959853994' },
];
const FALLBACK_LIKES = new Map([
  ['https://www.facebook.com/reel/1167958628558423', 227],
  ['https://www.facebook.com/reel/1406510241168380', 201],
  ['https://www.facebook.com/reel/1201528905398420', 453],
  ['https://www.facebook.com/reel/1704222193876563', 152],
  ['https://www.facebook.com/reel/865110959853994', 272],
]);

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 500, { error: 'File read error' });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function scrapeMetrics() {
  return new Promise((resolve, reject) => {
    const args = [
      SCRAPER,
      '--json=true',
      '--headless=true',
      '--source=direct',
      ...VIDEOS.map((v) => `--url=${v.url}`),
    ];

    execFile('node', args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const byUrl = new Map(parsed.results.map((r) => [r.inputUrl, r]));
        const merged = VIDEOS.map((v) => {
          const hit = byUrl.get(v.url) || {};
          return {
            id: v.id,
            title: v.title,
            url: v.url,
            likes: Number.isFinite(hit.likes) ? hit.likes : (FALLBACK_LIKES.get(v.url) ?? null),
          };
        });
        const totals = {
          likes: merged.reduce((s, v) => s + (Number.isFinite(v.likes) ? v.likes : 0), 0),
        };
        resolve({ videos: merged, totals });
      } catch (e) {
        reject(new Error(`JSON parse error: ${e.message}`));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', 'http://localhost');
  const pathname = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    sendFile(res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/api/metrics' || pathname === '/api/metrics/') {
    try {
      const data = await scrapeMetrics();
      sendJson(res, 200, data);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://127.0.0.1:${PORT}`);
});
