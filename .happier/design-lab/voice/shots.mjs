// Voice lab shots. Same contract as ../daybreak/shots.mjs (software WebGL flags, settle wait, clip the frame) because the
// planet is drawn by the Daybreak engine; plus DPR (default 2) and voice concept discovery.
//   node shots.mjs                          every variant of every registered voice concept, light + dark
//   node shots.mjs voice-presence           every variant of that concept, light + dark
//   node shots.mjs voice-presence:A:dark    exact combos (optional 4th field: wait ms)
// Detached runs: setsid node shots.mjs … > shots/run.log 2>&1 &   (FRESH=1: one browser per frame)
import {chromium} from '/home/leeroy.guest/.happier-stack/workspace/0.3/node_modules/playwright/index.mjs';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + here + '/index.html';
mkdirSync(here + '/shots', {recursive: true});
const DPR = Number(process.env.DPR || 2);
const ARGS = ['--no-sandbox', '--allow-file-access-from-files', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync', '--disable-frame-rate-limit'];
const launch = async () => { const b = await chromium.launch({headless: true, args: ARGS}); const p = await b.newPage({viewport: {width: 1560, height: 2400}, deviceScaleFactor: DPR}); return [b, p]; };
let [browser, page] = await launch();
const errs = []; const hook = (p) => { p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); }; hook(page);
let combos = process.argv.slice(2);
if (!combos.length || !combos[0].includes(':')) {
  await page.goto(base + '?notes=off');
  const all = await page.evaluate((w) => order.filter((c) => S[c] && (!w.length || w.includes(c))).flatMap((c) => Object.keys(S[c].variants).map((v) => `${c}:${v}`)), combos);
  combos = all.flatMap((c) => [c + ':light', c + ':dark']);
}
for (const c of combos) {
  if (process.env.FRESH) { try { await browser.close(); } catch {} [browser, page] = await launch(); hook(page); }
  const [concept, variant, theme = 'light', wait = '3500'] = c.split(':');
  errs.length = 0;
  try { await page.goto(`${base}?c=${concept}&v=${variant}&theme=${theme}&notes=off`, {waitUntil: 'domcontentloaded', timeout: 120000}); } catch { console.log('FAIL goto', c); continue; }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => { const e = document.querySelector('.win, .phone'); if (e) { e.style.zoom = ''; e.scrollIntoView({block: 'start', inline: 'start'}); } });
  await page.waitForTimeout(+wait);
  const el = await page.$('.win, .phone'); if (!el) { console.log('NO EL', c); continue; }
  // element screenshot: the shared shell now centres the frame, and a page clip drifted off it (2026-11-07)
  try { await el.screenshot({path: `${here}/shots/${concept}-${variant}-${theme}.png`, timeout: 120000}); } catch (e) { console.log('FAIL', c, e.message.slice(0, 120)); continue; }
  console.log('shot', concept, variant, theme, errs.length ? 'ERR: ' + [...new Set(errs)].join(' | ').slice(0, 400) : '');
}
try { await browser.close(); } catch {}
