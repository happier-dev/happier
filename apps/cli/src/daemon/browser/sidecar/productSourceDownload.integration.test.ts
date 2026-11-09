import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAutomationActionRequestV1 } from '@happier-dev/protocol';

// Only installation location is substituted; Chromium, page layout, input and
// download observation use the real product owners with an isolated profile.
const environment = vi.hoisted(() => ({ directory: '' }));
vi.mock('@/configuration', async importOriginal => {
    const actual = await importOriginal<typeof import('@/configuration')>();
    return { ...actual, configuration: new Proxy(actual.configuration, { get(target, key, receiver) {
        if (key === 'happyHomeDir') return environment.directory;
        if (key === 'logsDir') return join(environment.directory, 'logs');
        return Reflect.get(target, key, receiver);
    } }) };
});

import { createProductBrowserSidecarControlAdapterFactory } from './productSource';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { resolveManagedBrowserSidecarCandidate } from './source';

describe.skipIf(!process.env.HAPPIER_TEST_BROWSER_RUNTIME_HOME)('managed browser download input', () => {
    it('downloads when an agent clicks a wrapped inline link', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-browser-download-'));
        environment.directory = process.env.HAPPIER_TEST_BROWSER_RUNTIME_HOME ?? root;
        const content = 'QALOGIN disposable download\n';
        const server = createServer((request, response) => {
            if (request.url === '/download') {
                response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename=QALOGIN.txt' });
                response.end(content);
                return;
            }
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta charset="utf-8"><style>'
                + 'body{font:20px system-ui;padding:32px}input,button,a{font:inherit;margin:12px;padding:12px}input{display:block}'
                + '</style><h1>QALOGIN Journey</h1><p>Ready</p>'
                + '<label>QA password<input type="password"></label><label>CSS masked<input></label>'
                + '<div><label>Shadow password<input type="password"></label></div>'
                + '<button id="confirm">Accept input</button><button>Sign in with QA provider</button>'
                + '<a id="download" href="/download" download="QALOGIN.txt">Download QA file</a>');
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Download fixture did not bind');
        const profiles = createBrowserProfileStore({ storageRootDirectory: root,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
        let runtime: Awaited<ReturnType<ReturnType<typeof createProductBrowserSidecarControlAdapterFactory>>> | undefined;
        let service: ReturnType<typeof createBrowserAutomationDaemonService> | undefined;
        try {
            expect((await resolveManagedBrowserSidecarCandidate())?.available, 'A preinstalled pinned managed browser is required').toBe(true);
            runtime = await createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles })({ machineId: 'download-machine' });
            if (!runtime.ok || !runtime.contextCapture) throw new Error('Managed browser runtime unavailable');
            const capture = runtime.contextCapture;
            const view = { browserSessionId: 'download-session', viewId: 'download-view' };
            expect(await runtime.adapter.dispatchCommand({ kind: 'openView', commandId: 'download-open', focus: true, ...view,
                platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url: `http://127.0.0.1:${address.port}/` },
            })).toMatchObject({ status: 'dispatched' });
            service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
                transport: createControlAdapterAutomationTransport({ adapter: runtime.adapter, contextCapture: capture }),
            }) });
            const automation = service;
            let requestId = 0;
            const action = (actionKind: BrowserAutomationActionRequestV1['actionKind'], payload = {}) => automation.execute({
                v: 1, ...view, automationRequestId: `download:${++requestId}`, actionKind, payload,
                navigationGeneration: capture.getNavigationState?.(view)?.navigationGeneration ?? 0,
                requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'download-fixture' }, timeoutMs: 60_000,
            });
            expect(await action('waitFor', { selector: '#download' })).toMatchObject({ status: 'succeeded' });
            const handle = capture.resolvePageHandle(view);
            if (!handle) throw new Error('Download view is not bound');
            // The union rectangle includes empty space between the link's line
            // fragments. Keyboard activation still reaches this focused link.
            expect(await capture.transport.dispatchPageCommand({ ...handle, method: 'Runtime.evaluate', params: {
                expression: '(() => {const a=document.querySelector("#download");const r=a.getBoundingClientRect();'
                    + 'return {wrapped:a.getClientRects().length>1,centerHitsLink:a.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()',
                returnByValue: true,
            } })).toMatchObject({ result: { value: { wrapped: true, centerHitsLink: false } } });
            expect(await action('click', { selector: '#download' })).toMatchObject({ status: 'succeeded' });
            await vi.waitFor(() => expect(capture.interactions?.getState(view)?.downloads).toMatchObject([
                { state: 'completed', name: 'QALOGIN.txt', receivedBytes: Buffer.byteLength(content) },
            ]));
        } finally {
            service?.dispose();
            try { if (runtime?.ok) await runtime.dispose?.(); }
            finally {
                await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                await rm(root, { recursive: true, force: true });
            }
        }
    });
});
