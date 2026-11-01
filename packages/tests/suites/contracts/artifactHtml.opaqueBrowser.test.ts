import { build } from 'esbuild';
import { chromium, type Browser, type Frame, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArtifactHtmlBundleV1 } from '../../../protocol/src/artifacts/artifactHtmlV1';
import { admitCallerAuthoredUiSurfaceCapabilitiesV1 } from '../../../protocol/src/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import { createSurfaceContextFixture } from '../../../plugin-sdk/src/ui/surfaceContext.fixture';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const hostUrl = 'https://happier-host.invalid/';
let browser: Browser;
let owners: string;
let sdkBootstrap: string;

function bundle(files: Record<string, readonly [string, string | Uint8Array]>, entrypoint = 'index.html'): ArtifactHtmlBundleV1 {
    return { v: 1, entrypoint, files: Object.fromEntries(Object.entries(files).map(([path, [mime, body]]) => [path, {
        mime, contentBase64: Buffer.from(body).toString('base64'),
    }])) };
}

const cyclicStylesheets = {
    'a.css': '@import "./b.css"; #probe { color: rgb(17,34,51); padding-left: 7px }',
    'b.css': '@import url("./a.css"); #probe { color: rgb(68,85,102); padding-right: 11px }',
    'self.css': '@import "./self.css"; #probe { color: rgb(119,136,153) }',
};
const cyclicStyleOutcomes = {
    'a.css': { color: 'rgb(17, 34, 51)', left: '7px', right: '11px' },
    'b.css': { color: 'rgb(68, 85, 102)', left: '7px', right: '11px' },
    'self.css': { color: 'rgb(119, 136, 153)', left: '0px', right: '0px' },
};

async function readCyclicStyle(frame: Frame) {
    await frame.waitForLoadState('load');
    return frame.evaluate(() => {
        const style = getComputedStyle(document.querySelector('#probe')!);
        return { color: style.color, left: style.paddingLeft, right: style.paddingRight };
    });
}

async function withPage(run: (page: Page) => Promise<void>) {
    const page = await browser.newPage();
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
        // Model only the HTTP transport. The guest keeps real DOM, origin,
        // cookies, storage, CSP and browser navigation enforcement beneath it.
        await page.route(hostUrl, route => route.fulfill({ contentType: 'text/html', body: '<main id="artifact"></main>' }));
        await page.goto(hostUrl);
        await page.context().addCookies([{ name: 'credential', value: 'host-only', url: hostUrl }]);
        await page.evaluate(() => localStorage.setItem('credential', 'host-only'));
        await run(page);
    } catch (error) {
        throw appendBrowserDiagnostics(error, diagnostics());
    } finally {
        await page.close();
    }
}

async function setGuest(page: Page, html: string) {
    await page.setContent('<main id="artifact"></main>');
    await page.evaluate((srcdoc) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.srcdoc = srcdoc;
        document.body.append(frame);
    }, html);
    return page.frames().find(frame => frame !== page.mainFrame())!;
}

beforeAll(async () => {
    // This finite source/browser lane uses the same default Chromium launch as
    // scripts/plugin-platform/run-hosted-web-bridge-browser-qa.mjs.
    browser = await chromium.launch();
    const output = await build({
        stdin: {
            contents: `export { buildHostedHtmlDocument } from '${resolve(repo, 'apps/ui/sources/components/plugins/hostedWeb/buildHostedHtmlDocument.ts')}';
                export { buildArtifactHtmlSrcdoc, renderArtifactHtmlViewer } from '${resolve(repo, 'apps/server/sources/app/api/routes/share/artifactHtmlViewer.ts')}';
                export { ARTIFACT_HTML_RESPONSE_SANDBOX_CSP_V1, ARTIFACT_HTML_SHELL_CSP_V1 } from '${resolve(repo, 'packages/protocol/src/artifacts/artifactHtmlDocumentV1.ts')}';`,
            resolveDir: repo,
            sourcefile: 'artifact-html-browser-owners.ts',
        },
        bundle: true, write: false, format: 'iife', globalName: '__E2__', platform: 'browser', target: 'es2022',
        alias: {
            '@happier-dev/protocol/sharing/public-viewer': resolve(repo, 'packages/protocol/src/sharing/publicViewer.ts'),
            '@happier-dev/protocol/artifacts/artifactHtmlDocumentV1': resolve(repo, 'packages/protocol/src/artifacts/artifactHtmlDocumentV1.ts'),
            '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1': resolve(repo, 'packages/protocol/src/plugins/contributions/ui/hostedHtmlCapabilitiesV1.ts'),
            '@happier-dev/protocol/plugins/ui/hostedWebBridge': resolve(repo, 'packages/protocol/src/plugins/ui/hostedWebBridge.ts'),
        },
    });
    owners = output.outputFiles[0].text;
    const sdk = await build({
        stdin: {
            contents: `export { installHostedWebPluginUiHostApiClientBootstrap, awaitHostedWebPluginUiHostApiClientBootstrapFromCurrentRealm } from '${resolve(repo, 'packages/plugin-sdk/src/ui/hostedWebClientBootstrap.ts')}';`,
            resolveDir: repo,
            sourcefile: 'artifact-html-browser-sdk.ts',
        },
        bundle: true, write: false, format: 'iife', globalName: '__SDK__', platform: 'browser', target: 'es2022',
        alias: {
            '@happier-dev/protocol/plugins/ui/client': resolve(repo, 'packages/protocol/src/plugins/ui/client.ts'),
            '@happier-dev/protocol/plugins/data/hostedWebAccountDataBridgeV1': resolve(repo, 'packages/protocol/src/plugins/data/hostedWebAccountDataBridgeV1.ts'),
            '@happier-dev/protocol/plugins/ui/hostedWebBridge': resolve(repo, 'packages/protocol/src/plugins/ui/hostedWebBridge.ts'),
        },
    });
    sdkBootstrap = sdk.outputFiles[0].text;
});

afterAll(async () => { await browser?.close(); });

describe('opaque browser bundle boundary', () => {
    it.each([undefined, { hostMethods: ['context', 'watchContext'] }] as const)('plain caller HTML reaches ready, follows live theme and height, and forwards only trusted links (request %j)', async request => {
        await withPage(async page => {
            await page.addScriptTag({ content: owners });
            const shellCsp = await page.evaluate(() => Reflect.get(globalThis, '__E2__').ARTIFACT_HTML_SHELL_CSP_V1);
            await page.route(hostUrl, route => route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': shellCsp }, body: '<main id="artifact"></main>' }));
            await page.goto(hostUrl);
            await page.addScriptTag({ content: owners });
            const config = { identity: { instanceId: 'plain-caller', mountNonce: 'plain-nonce' }, frameOrigin: 'null', hostOrigin: new URL(hostUrl).origin };
            const surface = createSurfaceContextFixture();
            const admission = admitCallerAuthoredUiSurfaceCapabilitiesV1({ request, admittedHostMethods: ['context', 'watchContext'] });
            if (admission.kind !== 'admitted') throw new Error('expected_caller_admission');
            const methods = admission.advertisedHostMethods;
            const input = bundle({ 'index.html': ['text/html', `<style>html,body{margin:0}#content{height:137px;color:var(--happier-plugin-color-text)}</style>
                <div id="content"><a id="link" href="https://external.invalid/read">Read</a><input id="control" type="checkbox"></div><script>globalThis.authorRuns = (globalThis.authorRuns || 0) + 1</script>`] });
            // The remote host transport is modeled with canonical wire vectors.
            // The document, SDK, CSS mapping, CSP, ports and activation stay real.
            await page.evaluate(async ({ input, config, surface, methods }) => {
                const received: Array<{ kind: string; payload?: { height?: number; url?: string } }> = [];
                let port: MessagePort;
                let subscriptionId = '';
                let hostSequence = 0;
                const push = (kind: string, payload: unknown) => port.postMessage({ version: 1, direction: 'hostToFrame', sequence: ++hostSequence, identity: config.identity, kind, ...(kind === 'bootstrap' ? { origin: 'null' } : {}), payload });
                const handle = (message: { kind: string; payload?: Record<string, unknown>; sequence: number }) => {
                    received.push(message);
                    if (message.kind !== 'hostApi') return;
                    const wire = message.payload!;
                    if (wire.kind === 'negotiate') push('hostApi', { wireVersion: 1, identity: config.identity, kind: 'negotiated', apiVersion: '1.0.0', methods, surface });
                    else if (wire.kind === 'request' || wire.kind === 'subscribe') {
                        if (wire.kind === 'subscribe') subscriptionId = String(wire.subscriptionId);
                        push('hostApi', { wireVersion: 1, identity: config.identity, kind: 'result', requestId: wire.requestId, method: wire.method,
                            ...(wire.method === 'context' ? { result: { surface, activity: { active: true } } } : {}) });
                    }
                };
                window.addEventListener('message', event => {
                    if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data.kind !== 'ready') return;
                    port = event.ports[0]; port.onmessage = event => handle(event.data); port.start(); handle(event.data);
                    push('bootstrap', { apiVersion: '1.0.0', wireVersion: 1, identity: config.identity });
                });
                Reflect.set(globalThis, '__plainCaller', { received, pushTheme(color: string) {
                    surface.theme.colors.text = color;
                    push('hostApi', { wireVersion: 1, identity: config.identity, kind: 'subscription', subscriptionId, event: { surface, activity: { active: true } } });
                } });
                const frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts');
                frame.srcdoc = await Reflect.get(globalThis, '__E2__').buildHostedHtmlDocument(input, config, { externalHttpLinks: true });
                document.body.append(frame);
            }, { input, config, surface, methods });
            const frame = page.frames().find(frame => frame !== page.mainFrame())!;
            await frame.waitForLoadState('load');
            await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, '__plainCaller').received.some((message: { kind: string }) => message.kind === 'ready'))).toBe(true);
            await expect.poll(() => frame.evaluate(() => document.documentElement.style.getPropertyValue('--happier-plugin-color-text'))).toBe('#f0f0f0');
            await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, '__plainCaller').received.some((message: { kind: string; payload: { height?: number } }) => message.kind === 'heightChanged' && message.payload.height === 137))).toBe(true);
            await page.evaluate(() => Reflect.get(globalThis, '__plainCaller').pushTheme('#123456'));
            await frame.waitForFunction(() => document.documentElement.style.getPropertyValue('--happier-plugin-color-text') === '#123456');
            expect(await frame.evaluate(() => Reflect.get(globalThis, 'authorRuns'))).toBe(1);
            await frame.locator('#control').click();
            expect(await frame.locator('#control').isChecked()).toBe(true);
            await frame.evaluate(() => { document.querySelector<HTMLElement>('#content')!.style.height = '211px'; document.querySelector<HTMLElement>('#link')!.click(); });
            await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, '__plainCaller').received.some((message: { kind: string; payload: { height?: number } }) => message.kind === 'heightChanged' && message.payload.height === 211))).toBe(true);
            await frame.evaluate(() => { document.querySelector<HTMLElement>('#content')!.style.height = '73px'; });
            await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, '__plainCaller').received.some((message: { kind: string; payload: { height?: number } }) => message.kind === 'heightChanged' && message.payload.height === 73))).toBe(true);
            expect(await page.evaluate(() => Reflect.get(globalThis, '__plainCaller').received.filter((message: { kind: string }) => message.kind === 'openExternal'))).toEqual([]);
            await frame.locator('#link').click();
            await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, '__plainCaller').received.filter((message: { kind: string }) => message.kind === 'openExternal'))).toEqual([expect.objectContaining({ payload: { url: 'https://external.invalid/read' } })]);
            expect(await frame.evaluate(() => Reflect.get(window, 'origin'))).toBe('null');
        });
    });
    it('enforces stored none/exact/open policy for actual fetch and CDN assets under the inherited shell CSP', async () => {
        const font = await readFile(resolve(repo, 'apps/ui/sources/assets/fonts/Inter-Regular.ttf'));
        for (const viewer of ['Board', 'Artifact'] as const) {
            for (const mode of ['none', 'origins', 'open', 'shareOff'] as const) {
                await withPage(async page => {
                    const requests: string[] = [];
                    // An opaque srcdoc origin does not make CSP 'self' harmless:
                    // also probe the embedding origin, beyond the remote sites.
                    const hostnames = ['approved.invalid', 'other.invalid', new URL(hostUrl).hostname];
                    for (const hostname of hostnames) {
                        await page.route(`https://${hostname}/**`, async route => {
                            requests.push(route.request().url());
                            const path = new URL(route.request().url()).pathname;
                            const response = path.endsWith('.js') ? { contentType: 'text/javascript', body: 'globalThis.remoteExecuted = true' }
                                : path.endsWith('.css') ? { contentType: 'text/css', body: '#probe {color:rgb(17,34,51)}' }
                                : path.endsWith('.svg') ? { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"/>' }
                                : path.endsWith('.ttf') ? { contentType: 'font/ttf', body: font }
                                : { contentType: 'text/plain', body: 'network response' };
                            await route.fulfill({ ...response, headers: { 'Access-Control-Allow-Origin': '*' } });
                        });
                    }
                    await page.addScriptTag({ content: owners });
                    const shellCsp = await page.evaluate(() => Reflect.get(globalThis, '__E2__').ARTIFACT_HTML_SHELL_CSP_V1);
                    await page.route(hostUrl, route => route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': shellCsp }, body: '<main id="artifact"></main>' }));
                    await page.goto(hostUrl);
                    await page.addScriptTag({ content: owners });
                    const requestedCapabilities = mode === 'origins' ? { networkOrigins: ['https://approved.invalid'] }
                        : { network: mode === 'none' ? 'none' as const : 'open' as const };
                    const input = { ...bundle({ 'index.html': ['text/html', `<body><div id="probe">local</div><script>
                        const asset = (tag, property, url) => new Promise(resolve => {
                            const element = document.createElement(tag); if(tag === 'link') element.rel = 'stylesheet';
                            element.onload = () => resolve(true); element.onerror = () => resolve(false);
                            element[property] = url; document.body.append(element);
                        });
                        const probe = async (hostname) => {
                            const origin = 'https://' + hostname;
                            const results = await Promise.all([
                                fetch(origin + '/fetch').then(response => response.text()).then(() => true, () => false),
                                asset('script', 'src', origin + '/script.js'), asset('link', 'href', origin + '/style.css'),
                                asset('img', 'src', origin + '/image.svg'),
                                new FontFace('RemoteFont', 'url(' + origin + '/font.ttf)').load().then(() => true, () => false),
                            ]); return results;
                        };
                        Promise.all(['approved.invalid', 'other.invalid', 'happier-host.invalid'].map(probe)).then(results => document.body.dataset.network = JSON.stringify(results));
                    </script>`] }), requestedCapabilities };
                    await page.evaluate(async ({ input, viewer, mode, requestedCapabilities }) => {
                        const api = Reflect.get(globalThis, '__E2__');
                        if (viewer === 'Artifact') api.renderArtifactHtmlViewer(document.querySelector('#artifact'), input, 'network', { networkOff: mode === 'shareOff' });
                        else {
                            const frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts');
                            frame.srcdoc = await api.buildHostedHtmlDocument(input, undefined, mode === 'shareOff' ? { network: 'none' } : requestedCapabilities);
                            document.body.append(frame);
                        }
                    }, { input, viewer, mode, requestedCapabilities });
                    const frame = page.frames().find(candidate => candidate !== page.mainFrame())!;
                    await frame.waitForFunction(() => document.body.dataset.network);
                    const expected = mode === 'open' ? [true, true, true] : mode === 'origins' ? [true, false, false] : [false, false, false];
                    expect(JSON.parse(await frame.evaluate(() => document.body.dataset.network!))).toEqual(expected.map(allowed => Array(5).fill(allowed)));
                    expect(requests.length).toBe(expected.filter(Boolean).length * 5);
                    expect(await frame.evaluate(() => Reflect.get(window, 'origin'))).toBe('null');
                    if (mode === 'origins') expect(requests.every(url => new URL(url).hostname === 'approved.invalid')).toBe(true);
                    expect(await frame.evaluate(() => document.querySelector('#probe')?.textContent)).toBe('local');
                });
            }
        }
    });
    it('characterizes native CSS imports as skipping the cyclic edge while preserving each entrypoint cascade', async () => {
        await withPage(async page => {
            // Only HTTP transport is modeled; Chromium owns stylesheet loading,
            // cyclic import detection, media evaluation and cascade ordering.
            const cssOrigin = 'https://css-control.invalid/';
            await page.route(cssOrigin + '**', route => {
                const name = new URL(route.request().url()).pathname.slice(1) as keyof typeof cyclicStylesheets;
                return route.fulfill({ contentType: 'text/css', body: cyclicStylesheets[name] });
            });
            for (const root of Object.keys(cyclicStylesheets) as (keyof typeof cyclicStylesheets)[]) {
                const frame = await setGuest(page, `<link rel="stylesheet" href="${cssOrigin}${root}"><div id="probe">cycle</div>`);
                expect(await readCyclicStyle(frame)).toEqual(cyclicStyleOutcomes[root]);
                expect(await frame.evaluate(() => Reflect.get(window, 'origin'))).toBe('null');
            }
        });
    });

    it('Board response-header sandbox preserves local resources and SDK bootstrap in a top-level opaque document', async () => {
        const config = { identity: { instanceId: 'response-instance', mountNonce: 'response-nonce' }, frameOrigin: 'null', hostOrigin: hostUrl.slice(0, -1) };
        const input = bundle({
            'index.html': ['text/html', '<body><link rel="stylesheet" href="assets/style.css"><img id="image" src="assets/icon.svg"><div id="text">bundle</div><script type="module" src="js/main.js"></script>'],
            'js/main.js': ['text/javascript', `import { value } from './dependency.js';
                const text = await (await fetch(new URL('../data/value.txt', import.meta.url))).text();
                await document.fonts.ready;
                const image = document.querySelector('#image'); if (!image.complete) await new Promise(resolve => image.onload = resolve);
                document.body.dataset.result = JSON.stringify({value, text, image: image.naturalWidth, color: getComputedStyle(document.querySelector('#text')).color, font: document.fonts.check('12px BundleFont')});`],
            'js/dependency.js': ['text/javascript', 'export const value = "local module";'],
            'data/value.txt': ['text/plain', 'local resource'],
            'assets/style.css': ['text/css', '@font-face {font-family:BundleFont;src:url("./font.ttf")} #text {font-family:BundleFont;color:rgb(17,34,51)}'],
            'assets/icon.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"></svg>'],
            'assets/font.ttf': ['font/ttf', await readFile(resolve(repo, 'apps/ui/sources/assets/fonts/Inter-Regular.ttf'))],
        });
        await withPage(async page => {
            await page.addScriptTag({ content: owners });
            const response = await page.evaluate(async ({ input, config }) => {
                const api = Reflect.get(globalThis, '__E2__');
                return { html: await api.buildHostedHtmlDocument(input, config), csp: api.ARTIFACT_HTML_RESPONSE_SANDBOX_CSP_V1 };
            }, { input, config });
            const responseUrl = new URL('response.html', hostUrl).href;
            // This is the browser response-header boundary, not an Android or
            // desktop transport-loading proof. The HTML is the real owner output.
            await page.route(responseUrl, route => route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': response.csp }, body: response.html }));
            const network: string[] = [];
            page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
            await page.goto(responseUrl);
            await page.waitForFunction(() => document.body.dataset.result);
            await page.addScriptTag({ content: sdkBootstrap });
            const actual = await page.evaluate(async () => {
                const sdk = Reflect.get(globalThis, '__SDK__');
                const result: Record<string, unknown> = {};
                for (const [key, probe] of Object.entries({ cookies: () => document.cookie, storage: () => localStorage.getItem('credential') })) {
                    try { probe(); result[key] = 'allowed'; } catch { result[key] = 'denied'; }
                }
                let ready: unknown;
                // Native postMessage is the sole mocked system boundary. Real
                // SDK validation and lifecycle execute inside Chromium's realm.
                Reflect.set(globalThis, 'ReactNativeWebView', { postMessage(raw: string) {
                    const message = JSON.parse(raw);
                    ready = message;
                    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: {
                        version: 1, direction: 'hostToFrame', sequence: 1, identity: message.identity,
                        origin: 'null', kind: 'bootstrap', payload: { apiVersion: '1.0.0', wireVersion: 1, identity: message.identity, launchInput: { browserPolicy: 'response-header' } },
                    } })));
                } });
                const installed = sdk.installHostedWebPluginUiHostApiClientBootstrap(window);
                const bootstrap = await sdk.awaitHostedWebPluginUiHostApiClientBootstrapFromCurrentRealm();
                return { ...result, origin: Reflect.get(window, 'origin'), locationOrigin: location.origin, ready, installed, identity: bootstrap.identity, launchInput: bootstrap.launchInput, config: Reflect.get(globalThis, '__HAPPIER_UI_FRAME_BOOTSTRAP_V1__'), resources: JSON.parse(document.body.dataset.result!) };
            });
            expect(actual).toMatchObject({ cookies: 'denied', storage: 'denied', origin: 'null', installed: true, identity: config.identity, launchInput: { browserPolicy: 'response-header' }, config, ready: { kind: 'ready', identity: config.identity }, resources: { value: 'local module', text: 'local resource', image: 7, color: 'rgb(17, 34, 51)', font: true } });
            // URL origin and security origin differ for sandboxed HTTP documents.
            expect(actual.locationOrigin).toBe(new URL(hostUrl).origin);
            expect(network).toEqual([responseUrl]);
        });
    });

    for (const scheme of ['blob', 'data']) it(`characterizes native ${scheme} relative imports as unsupported and mapped modules as cycle-safe`, async () => {
        await withPage(async page => {
            const frame = await setGuest(page, `<script>
                (async () => {
                    const asset = text => ${scheme === 'blob' ? "URL.createObjectURL(new Blob([text], {type:'text/javascript'}))" : "'data:text/javascript;base64,' + btoa(text)"};
                    try { await import(asset('import "./sibling.js"')); document.body.dataset.relative = 'loaded'; }
                    catch (error) { document.body.dataset.relative = String(error); }
                    const imports = {
                        'https://bundle.invalid/a.js': asset('import {b} from "https://bundle.invalid/b.js"; export const a = () => b();'),
                        'https://bundle.invalid/b.js': asset('import {a} from "https://bundle.invalid/a.js"; export const b = () => "cycle"; export const invoke = () => a();')
                    };
                    const map = document.createElement('script'); map.type = 'importmap'; map.textContent = JSON.stringify({imports}); document.head.append(map);
                    const module = await import('https://bundle.invalid/a.js'); document.body.dataset.mapped = module.a();
                })();
                </script>`);
            await frame.waitForFunction(() => document.body.dataset.mapped === 'cycle');
            expect(await frame.evaluate(() => document.body.dataset.relative)).toMatch(/relative|resolve|module/i);
        });
    });

    for (const viewer of ['Board', 'Artifact'] as const) {
        it(`${viewer} preserves native cyclic CSS cascades without network requests`, async () => {
            await withPage(async page => {
                const network: string[] = [];
                page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
                for (const root of Object.keys(cyclicStylesheets) as (keyof typeof cyclicStylesheets)[]) {
                    const input = bundle({
                        'index.html': ['text/html', `<link rel="stylesheet" href="assets/${root}"><div id="probe">cycle</div>`],
                        ...Object.fromEntries(Object.entries(cyclicStylesheets).map(([name, css]) => [`assets/${name}`, ['text/css', css] as const])),
                    });
                    await page.setContent('<main id="artifact"></main>');
                    await page.addScriptTag({ content: owners });
                    await page.evaluate(async ({ input, viewer }) => {
                        const api = Reflect.get(globalThis, '__E2__');
                        if (viewer === 'Artifact') api.renderArtifactHtmlViewer(document.querySelector('#artifact'), input, 'cycle');
                        else {
                            const frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts');
                            frame.srcdoc = await api.buildHostedHtmlDocument(input); document.body.append(frame);
                        }
                    }, { input, viewer });
                    const frame = page.frames().find(frame => frame !== page.mainFrame())!;
                    expect(await readCyclicStyle(frame)).toEqual(cyclicStyleOutcomes[root]);
                    expect(await frame.evaluate(() => Reflect.get(window, 'origin'))).toBe('null');
                }
                expect(network).toEqual([]);
            });
        });

        it(`${viewer} renders folder modules, cycles, dynamic imports, CSS, image, font and relative fetch inside an opaque frame`, async () => {
            const input = bundle({
                'index.html': ['text/html', '<!doctype html><link rel="stylesheet" href="assets/style.css"><img id="image" src="assets/icon.svg"><div id="text">bundle</div><script type="module" src="js/main.js"></script>'],
                'js/main.js': ['text/javascript', `import { cycle } from './a.js';
                    const dynamic = await import('./dynamic.js');
                    const text = await (await fetch(new URL('../data/value.txt', import.meta.url))).text();
                    const relative = await (await fetch('./data/value.txt')).text();
                    const xhr = await new Promise((resolve, reject) => { const request = new XMLHttpRequest(); request.open('GET', './data/value.txt'); request.onload = () => resolve(request.responseText); request.onerror = reject; request.send(); });
                    await document.fonts.ready;
                    const image = document.querySelector('#image'); if (!image.complete) await new Promise(resolve => image.onload = resolve);
                    document.body.dataset.result = JSON.stringify({cycle: cycle(), dynamic: dynamic.value, text, relative, xhr, image: image.naturalWidth, color: getComputedStyle(document.querySelector('#text')).color, font: document.fonts.check('12px BundleFont')});`],
                'js/a.js': ['text/javascript', 'import { read } from "./b.js"; export const cycle = () => read();'],
                'js/b.js': ['text/javascript', 'import { cycle } from "./a.js"; export const read = () => "cycle"; export const again = () => cycle();'],
                'js/dynamic.js': ['text/javascript', 'export const value = "dynamic";'],
                'data/value.txt': ['text/plain', 'local resource'],
                'assets/style.css': ['text/css', '@import "./colors.css"; @font-face {font-family:BundleFont;src:url("./font.ttf")} #text {font-family:BundleFont}'],
                'assets/colors.css': ['text/css', '#text {color:rgb(17,34,51)}'],
                'assets/icon.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"><rect width="7" height="9" fill="red"/></svg>'],
                'assets/font.ttf': ['font/ttf', await readFile(resolve(repo, 'apps/ui/sources/assets/fonts/Inter-Regular.ttf'))],
            });
            await withPage(async page => {
                const network: string[] = [];
                page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
                await page.setContent('<main id="artifact"></main>');
                await page.addScriptTag({ content: owners });
                await page.evaluate(async ({ input, viewer }) => {
                    const api = Reflect.get(globalThis, '__E2__');
                    if (viewer === 'Artifact') api.renderArtifactHtmlViewer(document.querySelector('#artifact'), input, 'bundle');
                    else {
                        const frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts');
                        frame.srcdoc = await api.buildHostedHtmlDocument(input); document.body.append(frame);
                    }
                }, { input, viewer });
                const frame = page.frames().find(frame => frame !== page.mainFrame())!;
                await frame.waitForFunction(() => document.body.dataset.result);
                expect(JSON.parse(await frame.evaluate(() => document.body.dataset.result!))).toEqual({
                    cycle: 'cycle', dynamic: 'dynamic', text: 'local resource', relative: 'local resource', xhr: 'local resource', image: 7, color: 'rgb(17, 34, 51)', font: true,
                });
                expect(network).toEqual([]);
            });
        });

        it(`${viewer} denies host credentials, storage, file reads, workers, nested frames and top navigation`, async () => {
            const input = bundle({ 'index.html': ['text/html', `<body><script>
                const result = {};
                for (const [key, probe] of Object.entries({
                    parent: () => parent.document.body.innerHTML,
                    cookies: () => document.cookie,
                    storage: () => localStorage.getItem('credential'),
                    top: () => top.location.href = 'https://escape.invalid/',
                })) { try { probe(); result[key] = 'allowed'; } catch { result[key] = 'denied'; } }
                result.worker = 'pending';
                try { const worker = new Worker('data:text/javascript,postMessage(1)'); worker.onmessage = () => { result.worker = 'allowed'; worker.terminate(); }; worker.onerror = () => { result.worker = 'denied'; worker.terminate(); }; }
                catch { result.worker = 'denied'; }
                result.popup = window.open('https://popup.invalid/') === null ? 'denied' : 'allowed';
                result.native = typeof ReactNativeWebView === 'undefined' && typeof __TAURI__ === 'undefined';
                fetch('file:///etc/passwd').then(() => result.file = 'allowed', () => result.file = 'denied');
                fetch('https://egress.invalid/secret').then(() => result.network = 'allowed', () => result.network = 'denied');
                result.nested = 'blocked';
                window.__isolation = result;
                window.addEventListener('message', event => { if (event.data === 'nested-executed') result.nested = 'executed'; });
                const childHtml = '<iframe srcdoc="&lt;script&gt;parent.postMessage(&quot;nested-executed&quot;,&quot;*&quot;)&lt;/script&gt;"></iframe>';
                const attempt = run => { try { run(); } catch {} };
                attempt(() => { const nested = document.createElement('iframe'); nested.srcdoc = '<script>parent.postMessage("nested-executed","*")<' + '/script>'; document.body.append(nested); });
                attempt(() => document.body.append(document.createElementNS('http://www.w3.org/1999/xhtml', 'iframe')));
                attempt(() => { const div = document.createElement('div'); document.body.append(div); div.innerHTML = childHtml; });
                attempt(() => document.body.insertAdjacentHTML('beforeend', childHtml));
                attempt(() => { const parsed = new DOMParser().parseFromString(childHtml, 'text/html'); document.body.append(...parsed.body.childNodes); });
                attempt(() => document.body.append(document.createRange().createContextualFragment(childHtml)));
                attempt(() => { const div = document.createElement('div'); document.body.append(div); div.setHTMLUnsafe(childHtml); });
                attempt(() => { const div = document.createElement('div'); document.body.append(div); div.attachShadow({mode:'open'}).setHTMLUnsafe(childHtml); });
                attempt(() => { const parsed = Document.parseHTMLUnsafe(childHtml); document.body.append(...parsed.body.childNodes); });
                // Static HTML parsing can materialize a closed declarative
                // shadow root before insertion; childNodes cannot inspect it.
                attempt(() => { const parsed = Document.parseHTMLUnsafe('<div><template shadowrootmode="closed">' + childHtml + '</template></div>'); document.body.append(...parsed.body.childNodes); });
                // Authored globals cannot change how the admission owner
                // identifies real browser nodes at its insertion boundary.
                attempt(() => {
                    const nativeElement = globalThis.Element;
                    const nativeNode = globalThis.Node;
                    try {
                        Reflect.set(globalThis, 'Element', class {});
                        Reflect.set(globalThis, 'Node', class {});
                        const parsed = new DOMParser().parseFromString(childHtml, 'text/html');
                        document.body.append(...parsed.body.childNodes);
                    } finally {
                        Reflect.set(globalThis, 'Element', nativeElement);
                        Reflect.set(globalThis, 'Node', nativeNode);
                    }
                });
                attempt(() => {
                    const nativeHas = Set.prototype.has;
                    try {
                        Set.prototype.has = () => false;
                        const parsed = new DOMParser().parseFromString(childHtml, 'text/html');
                        document.body.append(...parsed.body.childNodes);
                    } finally { Set.prototype.has = nativeHas; }
                });
                attempt(() => {
                    const child = new DOMParser().parseFromString(childHtml, 'text/html').body.firstChild;
                    Object.defineProperty(child, 'localName', { value: 'div' });
                    document.body.append(child);
                });
                attempt(() => {
                    const wrapper = new DOMParser().parseFromString('<div>' + childHtml + '</div>', 'text/html').body.firstChild;
                    Object.defineProperty(wrapper, 'childNodes', { value: [] });
                    document.body.append(wrapper);
                });
                attempt(() => {
                    const nativeApply = Reflect.apply;
                    let nativeAppend;
                    try {
                        Reflect.apply = (method, receiver, args) => {
                            nativeAppend = method;
                            return nativeApply(method, receiver, args);
                        };
                        document.body.append('plain');
                    } finally { Reflect.apply = nativeApply; }
                    const child = new DOMParser().parseFromString(childHtml, 'text/html').body.firstChild;
                    nativeApply(nativeAppend, document.body, [child]);
                });
                attempt(() => {
                    const nativeSlice = Array.prototype.slice;
                    try {
                        Array.prototype.slice = () => [];
                        const child = new DOMParser().parseFromString(childHtml, 'text/html').body.firstChild;
                        document.body.appendChild(child);
                    } finally { Array.prototype.slice = nativeSlice; }
                });
                attempt(() => {
                    const nativeIterator = NodeList.prototype[Symbol.iterator];
                    try {
                        NodeList.prototype[Symbol.iterator] = function* () {};
                        const wrapper = new DOMParser().parseFromString('<div>' + childHtml + '</div>', 'text/html').body.firstChild;
                        document.body.append(wrapper);
                    } finally { NodeList.prototype[Symbol.iterator] = nativeIterator; }
                });
                attempt(() => {
                    const nativeIterator = Array.prototype[Symbol.iterator];
                    try {
                        Array.prototype[Symbol.iterator] = function* () {};
                        const child = new DOMParser().parseFromString(childHtml, 'text/html').body.firstChild;
                        document.body.append(child);
                    } finally { Array.prototype[Symbol.iterator] = nativeIterator; }
                });
                attempt(() => {
                    try {
                        Object.defineProperty(Element, Symbol.hasInstance, { configurable: true, value: () => false });
                        Object.defineProperty(Node, Symbol.hasInstance, { configurable: true, value: () => false });
                        const child = new DOMParser().parseFromString(childHtml, 'text/html').body.firstChild;
                        document.body.append(child);
                    } finally {
                        delete Element[Symbol.hasInstance];
                        delete Node[Symbol.hasInstance];
                    }
                });
                attempt(() => {
                    const nativeString = String;
                    try {
                        globalThis.String = () => '<p>safe</p>';
                        document.body.insertAdjacentHTML('beforeend', childHtml);
                    } finally { globalThis.String = nativeString; }
                });
                attempt(() => {
                    let conversions = 0;
                    document.body.insertAdjacentHTML('beforeend', {
                        toString() { return ++conversions === 1 ? '<p>safe</p>' : childHtml; },
                    });
                });
                attempt(() => {
                    let conversions = 0;
                    const wrapper = document.createElement('div');
                    document.body.append(wrapper);
                    wrapper.innerHTML = {
                        toString() { return ++conversions === 1 ? '<p>safe</p>' : childHtml; },
                    };
                });
                attempt(() => {
                    const child = new DOMParser().parseFromString(childHtml, 'text/html').body.firstChild;
                    Object.setPrototypeOf(child, null);
                    document.body.append(child);
                });
                </script></body>`] });
            await withPage(async page => {
                const network: string[] = [];
                page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
                await page.setContent('<main id="artifact"></main>');
                await page.addScriptTag({ content: owners });
                await page.evaluate(async ({ input, viewer }) => {
                    const api = Reflect.get(globalThis, '__E2__');
                    if (viewer === 'Artifact') api.renderArtifactHtmlViewer(document.querySelector('#artifact'), input, 'isolation');
                    else {
                        const frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts');
                        frame.srcdoc = await api.buildHostedHtmlDocument(input); document.body.append(frame);
                    }
                }, { input, viewer });
                const frame = page.frames().find(frame => frame !== page.mainFrame())!;
                await frame.waitForFunction(() => Reflect.get(globalThis, '__isolation')?.file && Reflect.get(globalThis, '__isolation')?.network && Reflect.get(globalThis, '__isolation')?.worker !== 'pending');
                // about:srcdoc can execute despite frame-src 'none'. Wait for
                // the document's child loads and queued messages so the probe
                // does not mistake an unobserved nested execution for denial.
                await frame.waitForLoadState('load');
                await frame.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
                expect(await frame.evaluate(() => document.querySelectorAll('iframe,frame,object,embed').length)).toBe(0);
                expect(await frame.evaluate(() => Reflect.get(globalThis, '__isolation'))).toEqual({
                    parent: 'denied', cookies: 'denied', storage: 'denied', worker: 'denied', top: 'denied', popup: 'denied', native: true, file: 'denied', network: 'denied', nested: 'blocked',
                });
                expect(page.url()).toBe(hostUrl);
                expect(page.context().pages()).toHaveLength(1);
                expect(network).toEqual([]);
                expect(await frame.evaluate(() => location.origin)).toBe('null');
            });
        });

        it(`${viewer} executes a valid expanded document larger than the WebView2 HTML-string boundary`, async () => {
            const size = 2 * 1024 * 1024 + 1;
            const input = bundle({
                'index.html': ['text/html', '<body><script>fetch("./payload.txt").then(r=>r.text()).then(text=>document.body.dataset.bytes=String(text.length))</script>'],
                'payload.txt': ['text/plain', 'x'.repeat(size)],
            });
            await withPage(async page => {
                await page.setContent('<main id="artifact"></main>');
                await page.addScriptTag({ content: owners });
                const expandedBytes = await page.evaluate(async ({ input, viewer }) => {
                    const api = Reflect.get(globalThis, '__E2__');
                    const html = viewer === 'Artifact' ? api.buildArtifactHtmlSrcdoc(input, document) : await api.buildHostedHtmlDocument(input);
                    const frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts'); frame.srcdoc = html; document.body.append(frame);
                    return new TextEncoder().encode(html).byteLength;
                }, { input, viewer });
                expect(expandedBytes).toBeGreaterThan(2 * 1024 * 1024);
                const frame = page.frames().find(frame => frame !== page.mainFrame())!;
                await frame.waitForFunction(() => document.body.dataset.bytes);
                expect(await frame.evaluate(() => document.body.dataset.bytes)).toBe(String(size));
            });
        });
    }
});
