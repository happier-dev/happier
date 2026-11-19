// Compare picture resettling at Home's geometry, including its real frame intervals.
// Usage (repo root): U9B_CHROME=<chromium path> node apps/ui/tools/atmosphere/homeMomentsHarness.mjs
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ui = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(ui, '../..');
const shots = join(
  repo,
  '.project/plans/2026-10-10-home-atmosphere/lanes/U9b-shots',
);
const lab = join(repo, '.happier/design-lab/atmosphere/shots');
const bundle = await build({
  entryPoints: [join(ui, 'sources/dev/atmosphere/HomeMomentsHarness.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  write: false,
  tsconfig: join(ui, 'tsconfig.json'),
  define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
  alias: {
    'react-native': join(ui, 'sources/dev/atmosphere/canvasHarnessBoundary.ts'),
    '@/components/ui/motion/motionTokens': join(
      ui,
      'sources/dev/atmosphere/momentHarnessMotion.ts',
    ),
  },
});
// The clock the stills are frozen on: frames are held and handed chosen timestamps.
const clock = `(() => { const raf = window.requestAnimationFrame.bind(window); let queue = [];
  window.__qa = { hold: false, pending: () => queue.length, step(ts) { const q = queue; queue = []; q.forEach((cb) => cb(ts)); return q.length; } };
  window.requestAnimationFrame = (cb) => { if (!window.__qa.hold) return raf(cb); queue.push(cb); return 1e9 + queue.length; }; })();`;
const fonts = ['IBMPlexMono-Regular', 'IBMPlexMono-SemiBold']
  .map(
    (name) =>
      `@font-face{font-family:"${name}";src:url('/apps/ui/sources/assets/fonts/${name}.ttf')}`,
  )
  .join('');
const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#f5f5f5}${fonts}#product{display:inline-block}</style>
<script>${clock}</script><div id="product"></div><script src="/harness.js"></script>`;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(html);
      return;
    }
    if (pathname === '/harness.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(bundle.outputFiles[0].text);
      return;
    }
    const file =
      pathname === '/happier-atmosphere-worker.js'
        ? join(ui, 'public/happier-atmosphere-worker.js')
        : resolve(repo, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(repo + '/')) {
      response.writeHead(403).end();
      return;
    }
    const types = {
      '.js': 'text/javascript',
      '.ttf': 'font/ttf',
      '.jpg': 'image/jpeg',
      '.png': 'image/png',
    };
    response.setHeader(
      'content-type',
      types[extname(file)] ?? 'application/octet-stream',
    );
    response.end(await readFile(file));
  } catch (error) {
    response.writeHead(404).end(String(error));
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const require = createRequire(join(repo, 'packages/tests/package.json'));
const { chromium } = require('playwright');
const browser = await chromium.launch({
  executablePath: process.env.U9B_CHROME,
});
const report = { resettle: {} };
const stats = (intervals) => {
  const sorted = [...intervals].sort((a, b) => a - b);
  return {
    frames: intervals.length,
    meanMs: +(intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(
      2,
    ),
    p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
    maxMs: +sorted.at(-1).toFixed(2),
    over20Ms: intervals.filter((v) => v > 20).length,
    // Where the long frames fall: elapsed ms at the end of each, from the first frame.
    longAtMs: intervals.reduce((list, v, i) => (v > 20 ? [...list, Math.round(intervals.slice(0, i + 1).reduce((a, b) => a + b, 0))] : list), []),
  };
};
try {
  await mkdir(shots, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(window.U9H));
  const product = page.locator('#product');
  // The lab's resettle board: White rocks settles into Calm Sea, 560 × 226 bands, raw progress 0.3/0.55/0.8.
  const from = {
    fromId: 'white-rocks-open-sea',
    fromFile: '/.happier/design-lab/landscapes/assets/photos/p501.jpg',
  };
  const to = {
    toId: 'calm-sea',
    toFile: '/.happier/design-lab/landscapes/assets/plates/calmsea-courbet.jpg',
  };
  // The product eases its 1.8 s in and out; this is the instant whose eased progress is the lab's t.
  const instant = (y) =>
    1800 * (y < 0.5 ? Math.cbrt(y / 4) : 1 - Math.cbrt(2 * (1 - y)) / 2);
  for (const theme of ['light', 'dark']) {
    const band = { theme, width: 560, height: 226 };
    await page.evaluate((input) => window.U9H.resettleMount(input), {
      ...band,
      ...from,
    });
    await product.screenshot({
      path: join(shots, `resettle-live-${theme}-before.png`),
    });
    await page.evaluate(() => {
      window.__qa.hold = true;
    });
    await page.evaluate((input) => window.U9H.resettleTo(input), {
      ...band,
      ...to,
    });
    await page.waitForFunction(() => window.__qa.pending() > 0);
    await page.evaluate(() => window.__qa.step(10_000));
    for (const t of [0.3, 0.55, 0.8]) {
      await page.evaluate((ts) => window.__qa.step(ts), 10_000 + instant(t));
      await product.screenshot({
        path: join(shots, `resettle-live-${theme}-t${t}.png`),
      });
    }
    await page.evaluate(() => window.__qa.step(10_000 + 1800));
    await product.screenshot({
      path: join(shots, `resettle-live-${theme}-after.png`),
    });
    // Reduced motion: the same change as a cross-fade in the shared reduced time (shown at its midpoint).
    await page.evaluate((input) => window.U9H.resettleMount(input), {
      ...band,
      ...from,
    });
    await page.evaluate((input) => window.U9H.resettleTo(input), {
      ...band,
      ...to,
      reducedMotion: true,
    });
    await page.waitForFunction(() => window.__qa.pending() > 0);
    await page.evaluate(() => window.__qa.step(20_000));
    await page.evaluate(() => window.__qa.step(20_070));
    await product.screenshot({
      path: join(shots, `resettle-reduced-${theme}-mid.png`),
    });
    await page.evaluate(() => {
      window.__qa.step(20_140);
      window.__qa.hold = false;
    });
  }
  // Real frames: Home's band (991 × 600) and the Wallpaper window (1440 × 900).
  for (const [name, size] of [
    ['band', { width: 991, height: 600 }],
    ['wallpaper', { width: 1440, height: 900 }],
  ]) {
    await page.evaluate((input) => window.U9H.resettleMount(input), {
      theme: 'light',
      ...size,
      ...from,
    });
    const intervals = await page.evaluate(
      async (input) => {
        const list = [];
        let last = null;
        const until = performance.now() + 2200;
        const done = new Promise((resolve) => {
          const tick = (time) => {
            if (last !== null) list.push(time - last);
            last = time;
            if (time < until) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        await window.U9H.resettleTo(input);
        await done;
        return list;
      },
      { theme: 'light', ...size, ...to },
    );
    report.resettle[name] = stats(intervals);
  }

  // Lab beside live at matching scale (the lab's shots are 2× captures too).
  const sideBySide = async (name, left, right, caption) => {
    const data = async (file) =>
      `data:image/png;base64,${(await readFile(file)).toString('base64')}`;
    const compose = await browser.newPage({
      viewport: { width: 1200, height: 800 },
      deviceScaleFactor: 1,
    });
    await compose.setContent(`<body style="margin:0;background:#888;font:14px sans-serif;color:#fff"><div id="c" style="display:inline-flex;gap:16px;padding:16px;align-items:flex-start">
      <figure style="margin:0"><figcaption>lab</figcaption><img src="${await data(left)}"></figure>
      <figure style="margin:0"><figcaption>live · ${caption}</figcaption><img src="${await data(right)}"></figure></div></body>`);
    await compose.locator('#c').screenshot({ path: join(shots, name) });
    await compose.close();
  };
  for (const theme of ['light', 'dark']) {
    for (const t of [0.3, 0.55, 0.8])
      await sideBySide(
        `resettle-${theme}-t${t}.png`,
        join(lab, `at2-typing-resettle-${theme}.png`),
        join(shots, `resettle-live-${theme}-t${t}.png`),
        `resettle t = ${t}, 560 × 226`,
      );
  }
  report.errors = errors;
  await writeFile(
    join(shots, 'harness-report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}
