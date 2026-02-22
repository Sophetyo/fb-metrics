#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const SCRAPER = path.join(ROOT, 'scrape-fb-metrics.js');
const OUT = path.join(ROOT, 'metrics.json');

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

function run() {
  let previous = null;
  if (fs.existsSync(OUT)) {
    try {
      previous = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    } catch (_) {
      previous = null;
    }
  }
  const previousByUrl = new Map(
    (previous?.videos || []).map((v) => [v.url, v])
  );

  const args = [
    SCRAPER,
    '--json=true',
    '--headless=false',
    '--source=direct',
    ...VIDEOS.map((v) => `--url=${v.url}`),
  ];

  execFile('node', args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      console.error(stderr || err.message);
      process.exit(1);
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      console.error(`JSON parse error: ${e.message}`);
      process.exit(1);
    }

    const byUrl = new Map(parsed.results.map((r) => [r.inputUrl, r]));
    const videos = VIDEOS.map((v) => {
      const row = byUrl.get(v.url) || {};
      const old = previousByUrl.get(v.url) || {};
      const likes = Number.isFinite(row.likes)
        ? row.likes
        : (Number.isFinite(old.likes) ? old.likes : (FALLBACK_LIKES.get(v.url) ?? null));
      return {
        id: v.id,
        title: v.title,
        url: v.url,
        likes,
      };
    });

    const payload = {
      updatedAt: new Date().toISOString(),
      videos,
      totals: {
        likes: videos.reduce((s, v) => s + (Number.isFinite(v.likes) ? v.likes : 0), 0),
      },
    };

    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`metrics.json updated: ${OUT}`);
    console.log(`total likes: ${payload.totals.likes}`);
  });
}

run();
