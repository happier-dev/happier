import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';

const [, , expoUrl, featuresUrl] = process.argv;
if (!expoUrl || !featuresUrl) throw new Error('Usage: node glyphSpecimenAppleGpu.mjs EXPO_URL SERVER_FEATURES_URL');

const features = await fetch(featuresUrl).then(response => response.json());
console.log(JSON.stringify({ webappUrl: features.capabilities?.server?.webappUrl ?? null }));

// A remote Expo HTTP socket needs a loopback browser origin for WebCrypto. The bundle still comes
// from the running stack and the probe publishes no server outside this Mac.
const expo = new URL(expoUrl);
const proxy = expo.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(expo.hostname) ? http.createServer((request, response) => {
    const upstream = http.request(new URL(request.url, expo), {
        method: request.method, headers: { ...request.headers, host: expo.host },
    }, (reply) => {
        response.writeHead(reply.statusCode, reply.headers);
        reply.pipe(response);
    });
    upstream.on('error', error => response.writeHead(502).end(error.message));
    request.pipe(upstream);
}) : null;
if (proxy) {
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
}
const browserUrl = proxy ? `http://127.0.0.1:${proxy.address().port}` : expoUrl;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const waitForSpecimen = { timeout: 120_000 };
try {
    const gpu = await browser.newBrowserCDPSession().then(session => session.send('SystemInfo.getInfo'));
    console.log(JSON.stringify({ gpu: gpu.gpu.devices, webgl2: gpu.gpu.featureStatus?.webgl2 }));
    for (const scale of [1, 2]) {
        const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 1080, height: 860 } });
        const diagnostics = [];
        let bundle = null;
        const session = await page.context().newCDPSession(page);
        await session.send('Log.enable');
        session.on('Log.entryAdded', ({ entry }) => {
            if (/CONTEXT_LOST|Metal error/i.test(entry.text)) diagnostics.push(entry.text);
        });
        page.on('pageerror', error => diagnostics.push(error.message));
        page.on('response', response => {
            if (response.url().includes('.bundle?')) bundle = response.url();
        });
        for (const theme of ['light', 'dark']) for (const opaque of ['0', '1']) {
            const cycles = scale === 2 && theme === 'dark' && opaque === '0' ? 20 : 1;
            const url = new URL('/dev/glyphs', browserUrl);
            url.search = new URLSearchParams({ theme, opaque, cycles });
            await page.goto(url.href);
            const marker = page.getByTestId(`glyph-specimen-ready-${cycles}-${scale}`);
            try {
                await marker.or(page.locator('[data-testid^="glyph-specimen-still-"]')).waitFor(waitForSpecimen);
            } catch (error) {
                console.error(JSON.stringify({ url: page.url(), bundle, diagnostics, body: (await page.locator('body').innerText()).slice(0, 350) }));
                throw error;
            }
            const render = await page.getByTestId('glyph-specimen-surface').locator('canvas').first().evaluate(canvas => ({ ...canvas.dataset }));
            assert.equal(render.glyphLinked, 'true', JSON.stringify(render));
            assert.ok(Number.isFinite(Number(render.glyphFirstDrawMs)));
            assert.equal(Number(render.glyphContextLost ?? 0), 0);
            assert.deepEqual(diagnostics, []);
            assert.ok(bundle, 'Expo entry bundle URL');
            console.log(JSON.stringify({ bundle: new URL(new URL(bundle).pathname + new URL(bundle).search, expo).href,
                theme, opaque: opaque === '1', scale, cycles, ...render }));
        }
        await page.close();
    }
    for (const reason of ['no-webgl2', 'link', 'caveat']) {
        const page = await browser.newPage();
        await page.addInitScript(reason => {
            const getContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, attributes) {
                if (type === 'webgl2') {
                    if (reason === 'no-webgl2') return null;
                    if (reason === 'caveat' && attributes?.failIfMajorPerformanceCaveat) {
                        document.documentElement.dataset.caveatRefused = 'true';
                        return null;
                    }
                }
                return getContext.call(this, type, attributes);
            };
            if (reason === 'link') {
                const get = WebGL2RenderingContext.prototype.getProgramParameter;
                WebGL2RenderingContext.prototype.getProgramParameter = function (program, parameter) {
                    if (parameter === this.LINK_STATUS) {
                        document.documentElement.dataset.linkRefused = 'true';
                        return false;
                    }
                    return get.call(this, program, parameter);
                };
            }
        }, reason);
        await page.goto(new URL('/dev/glyphs', browserUrl).href);
        await page.getByTestId('glyph-specimen-still-0-1').waitFor(waitForSpecimen);
        const ink = await page.getByTestId('glyph-specimen-surface').locator('canvas').last().evaluate(canvas => {
            const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
            return data.some((value, index) => index % 4 === 3 && value > 0);
        });
        assert.equal(ink, true);
        if (reason !== 'no-webgl2') assert.equal(await page.locator('html').getAttribute(`data-${reason}-refused`), 'true');
        console.log(JSON.stringify({ reason, result: 'still' }));
        await page.close();
    }
} finally {
    await browser.close();
    proxy?.close();
}
