#!/usr/bin/env node

const path = require('path');
const { chromium } = require('playwright');

async function main() {
  const out = path.resolve(process.cwd(), process.argv[2] || 'fb-session.json');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: 'fr-FR' });
  const page = await context.newPage();

  console.log('1) Connecte-toi a Facebook dans la fenetre qui s\'ouvre.');
  console.log('2) Ouvre un reel/publication de ta page pour verifier que tu vois les vrais compteurs.');
  console.log('3) Reviens ici et appuie ENTREE pour sauvegarder la session.');

  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => resolve());
  });

  await context.storageState({ path: out });
  console.log(`Session enregistree: ${out}`);

  await context.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
