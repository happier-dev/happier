import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const ui = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(ui, '../..');
const bundle = await build({ entryPoints: [join(ui, 'sources/dev/atmosphere/CanvasHarness.tsx')], bundle: true,
    platform: 'browser', format: 'iife', jsx: 'automatic', write: false, tsconfig: join(ui, 'tsconfig.json'),
    alias: { 'react-native': join(ui, 'sources/dev/atmosphere/canvasHarnessBoundary.ts') } });
const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#f5f5f5}@font-face{font-family:IBMPlexMono-Regular;src:url('/apps/ui/sources/assets/fonts/IBMPlexMono-Regular.ttf')}@font-face{font-family:IBMPlexMono-SemiBold;src:url('/apps/ui/sources/assets/fonts/IBMPlexMono-SemiBold.ttf')}</style><div id="product"></div><script src="/harness.js"></script>`;
const server = createServer(async (request, response) => {
    try {
        if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
        if (request.url === '/harness.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle.outputFiles[0].text); return; }
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const file = pathname === '/happier-atmosphere-worker.js' ? join(ui, 'public/happier-atmosphere-worker.js') : resolve(repo, `.${pathname}`);
        if (!file.startsWith(repo + '/')) { response.writeHead(403).end(); return; }
        const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.jpg': 'image/jpeg', '.png': 'image/png' };
        response.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
        response.end(await readFile(file));
    } catch (error) { response.writeHead(404).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const require = createRequire(join(repo, 'packages/tests/package.json'));
const { chromium } = require('playwright');
const browser = await chromium.launch({ executablePath: process.env.U4_CHROME });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.U4));
    const fixture = JSON.parse(await readFile(join(repo, 'packages/brand/fixtures/atmosphere-parity.json'), 'utf8'));
    for (const reference of fixture.cases) {
        const source = fixture.inputs[reference.input];
        const { effect, dark, page: colour, mute, strength, ...rest } = reference.job;
        const job = { ...rest, look: effect, theme: dark ? 'dark' : 'light', page: colour, params: { ...rest.params, mute, strength } };
        const result = await page.evaluate(async ({ job, source }) => {
            const decoded = atob(source.rgba);
            return window.U4.backdrop({ ...job, source: { w: source.w, h: source.h, rgba: Uint8ClampedArray.from(decoded, c => c.charCodeAt(0)) } });
        }, { job, source });
        assert.deepEqual(result.rgba, result.expected, `putImageData ${reference.id}`);
        assert.equal(createHash('sha256').update(Uint8Array.from(result.rgba)).digest('hex'), reference.sha256, `fixture ${reference.id}`);
    }
    const shots = join(repo, '.project/plans/2026-10-10-home-atmosphere/lanes/U4-shots');
    await mkdir(shots, { recursive: true });
    await page.evaluate(() => window.U4.strictBackdrop());
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const theme of ['light', 'dark']) {
        for (const look of ['fine', 'painted']) {
            await page.evaluate(async ({ theme, look, origin }) => {
                document.body.style.background = document.documentElement.style.background = theme === 'dark' ? '#131111' : '#f5f5f5';
                const blob = await (await fetch(origin + '/.happier/design-lab/landscapes/assets/plates/calmsea-courbet.jpg')).blob();
                return window.U4.picture({ source: { localId: 'calm-sea', kind: 'builtin', createdAtMs: 0, size: blob.size, data: blob },
                    size: { width: 1440, height: 500 }, look, theme, page: theme === 'dark' ? [19,17,17] : [245,245,245],
                    params: { strength: 1 }, dissolve: { style: 'ordered', from: 0.46, to: 1 }, dpr: 1 });
            }, { theme, look, origin });
            await page.screenshot({ path: join(shots, `backdrop-${theme}-${look}.png`), clip: { x: 0, y: 0, width: 1440, height: 500 } });
        }
    }
    await page.evaluate(() => window.U4.unmount());
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ origin, backdropCases: fixture.cases.length, pageErrors: errors, shots }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
