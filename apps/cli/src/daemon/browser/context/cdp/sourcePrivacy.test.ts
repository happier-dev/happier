import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { browserContextSensitiveFieldsExpression } from '@happier-dev/protocol/browser/context/privacy';
import { createBrowserContextCaptureService } from '../capture';
import { connectBrowserSidecarCdpTransport } from '../../sidecar/cdpTransport';
import { createCdpBrowserContextSource } from './source';

// Opt-in source-level Chromium fixture: use an installed executable, never acquire/build one.
const executable = process.env.HAPPIER_TEST_BROWSER_EXECUTABLE;
describe.skipIf(!executable)('live Chromium context privacy', () => {
    it.each([
        { kind: 'url', html: '<button>Public page content</button><input type="password" value="password-canary">' },
        { kind: 'otp', html: '<input autocomplete="one-time-code" value="482913">' },
        { kind: 'css', html: '<input style="-webkit-text-security:disc" value="css-canary">' },
        { kind: 'shadow', html: '<div id="host"></div><script>document.querySelector("#host").attachShadow({mode:"closed"}).innerHTML=\'<input type="password" value="shadow-canary">\'</script>' },
        { kind: 'child', html: '<iframe srcdoc="&lt;input type=\'password\' value=\'child-canary\'&gt;"></iframe>' },
        { kind: 'whitespace', html: '<button>Public page content</button><span style="-webkit-text-security:disc"><b>12</b> <b>34</b></span>' },
        { kind: 'public', html: '<button>Public page content</button>' },
    ])('protects $kind page through the capture owner', async ({ kind, html }) => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-context-privacy-'));
        const server = createServer((_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(`<!doctype html>${html}`);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
        const url = `http://127.0.0.1:${address.port}/reset-password?token=query-canary#access_token=fragment-canary`;
        const child = spawn(executable!, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${directory}`],
            { stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'] });
        const exited = once(child, 'exit');
        let transport: Awaited<ReturnType<typeof connectBrowserSidecarCdpTransport>> | undefined;
        try {
            if (!(child.stdio[3] instanceof Writable) || !(child.stdio[4] instanceof Readable)) throw new Error('Missing CDP pipe');
            transport = await connectBrowserSidecarCdpTransport({ pipe: { writable: child.stdio[3], readable: child.stdio[4] } });
            const handle = await transport.openPage({ url: 'about:blank', focus: false });
            await transport.dispatchPageCommand({ ...handle, method: 'Page.enable' });
            let unsubscribe = () => {};
            const loaded = new Promise<void>(resolve => {
                unsubscribe = transport!.subscribeCdpEvents(event => {
                    if (event.sessionId === handle.sessionId && event.method === 'Page.loadEventFired') { unsubscribe(); resolve(); }
                });
            });
            try {
                await transport.dispatchPageCommand({ ...handle, method: 'Page.navigate', params: { url } });
                await loaded;
            } finally { unsubscribe(); }
            let writes = 0;
            const source = createCdpBrowserContextSource({ transport, resolveView: () => handle,
                screenshotMediaWriter: { write: async () => { writes++; return { ok: true, media: {
                    mediaId: 'fixture', mediaKind: 'image', width: 800, height: 600, sizeBytes: 1,
                } }; } },
            });
            const service = createBrowserContextCaptureService({ ownerAccountId: 'owner', source,
                resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }) });
            const request = { browserSessionId: 'privacy', viewId: 'page', navigationGeneration: 1,
                requesterAccountId: 'owner', contextId: 'fixture' };
            const snapshot = await service.captureSnapshot(request);
            expect(snapshot).toMatchObject({ status: 'captured', snapshot: { url: `http://127.0.0.1:${address.port}/reset-password` } });
            for (const secret of ['query-canary', 'fragment-canary', 'password-canary', '482913', 'css-canary', 'shadow-canary', 'child-canary']) {
                expect(JSON.stringify(snapshot)).not.toContain(secret);
            }
            if (kind === 'whitespace') expect(snapshot).toMatchObject({ snapshot: { visibleText: 'Public page content [MASKED]' } });
            expect(await service.captureScreenshot(request)).toMatchObject(kind === 'public'
                ? { status: 'captured' } : { status: 'unavailable', item: { lifecycleState: 'sensitiveFieldsPresent' } });
            expect(writes).toBe(kind === 'public' ? 2 : 0);
            if (kind === 'otp') {
                // The native Wry producer consumes the shared script instead of CDP's census.
                expect(await transport.dispatchPageCommand({ ...handle, method: 'Runtime.evaluate',
                    params: { expression: browserContextSensitiveFieldsExpression, returnByValue: true },
                })).toMatchObject({ result: { value: true } });
            }
        } finally {
            transport?.dispose();
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            await exited;
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });
});
