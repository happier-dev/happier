import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { connectBrowserSidecarCdpTransport } from '../../sidecar/cdpTransport';
import { createBrowserSidecarCdpControlAdapter } from '../../sidecar/controlAdapter';
import { createControlAdapterAutomationTransport } from './controlBridge';
import { createBrowserAutomationCdpAdapter } from './cdp';
import { createBrowserAutomationDaemonService } from '../service';

// Explicit native boundary lane; ordinary unit runs do not require a browser install.
const executable = process.env.HAPPIER_TEST_CHROMIUM_EXECUTABLE;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it.skipIf(!executable)('activates buttons and submits forms with native keys while preserving pointer clicks', async () => {
    const server = createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<body><button id="button" onclick="window.clicks++">Increment</button><form onsubmit="event.preventDefault(); window.submits++"><input id="field"><button>Submit</button></form><script>window.clicks=0; window.submits=0</script></body>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const profile = await mkdtemp(join(tmpdir(), 'happier-input-keys-'));
    const child = spawn(executable!, ['--headless', '--no-sandbox', '--remote-debugging-pipe', `--user-data-dir=${profile}`],
        { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    console.log(`Owned Chromium PID: ${child.pid}`);
    const exited = once(child, 'exit');
    const writable = child.stdio[3];
    const readable = child.stdio[4];
    if (!(writable instanceof Writable) || !(readable instanceof Readable)) throw new Error('Missing Chromium pipe');
    const transport = await connectBrowserSidecarCdpTransport({ pipe: { readable, writable } });
    const view = { browserSessionId: 'native-keys', viewId: 'page' };
    const adapter = createBrowserSidecarCdpControlAdapter({ ...view, sidecarId: 'native', transport });
    const contextCapture = { transport, resolvePageHandle: adapter.resolvePageHandle,
        getNavigationState: adapter.getNavigationState, subscribeCdpEvents: transport.subscribeCdpEvents,
        subscribeViewLifecycle: adapter.subscribeViewLifecycle };
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
        transport: createControlAdapterAutomationTransport({ adapter, contextCapture }),
    }) });
    const producer = createBrowserCdpScreencastProducer({ contextCapture });
    const registry = createMachineLiveStreamCaptureRegistry();
    const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => service });
    const relay = createMachineLiveStreamRelayTerminator({ captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry),
        machineId: 'machine', nowMs: Date.now, emitEnvelope: () => {} });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await adapter.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', focus: true, platform: 'web',
            target: { kind: 'externalUrl', targetId: 'fixture', url: `http://127.0.0.1:${address.port}/` } });
        const handle = adapter.resolvePageHandle(view)!;
        const evaluate = async (expression: string): Promise<unknown> => {
            const response = await transport.dispatchPageCommand({ ...handle, method: 'Runtime.evaluate', params: { expression, returnByValue: true } });
            return (response as { result: { value?: unknown } }).result.value;
        };
        await vi.waitFor(async () => expect(await evaluate('Boolean(document.querySelector("#button"))')).toBe(true));
        let sequence = 0;
        const execute = (actionKind: 'press' | 'click', payload: Record<string, unknown>) => service.execute({
            v: 1, ...view, automationRequestId: `key:${++sequence}`, requestedBy: 'user', requesterRef: { kind: 'streamViewer', id: 'viewer' },
            navigationGeneration: contextCapture.getNavigationState(view)?.navigationGeneration ?? 0,
            actionKind, payload, timeoutMs: 10_000,
        });
        // Control: native pointer activation works on this exact page before testing keys.
        expect(await execute('click', { selector: '#button' })).toMatchObject({ status: 'succeeded' });
        expect(await evaluate('window.clicks')).toBe(1);
        const sourceId = browserViewKey(view);
        const now = Date.now();
        expect(await relay.start({ v: 1, streamId: 'human', streamFamily: 'browser.streamed', sourceId,
            sourceMachineId: 'machine', targetMachineId: 'machine', routeKind: 'server_relay',
            authorization: { payload: { v: 1, grantId: 'grant', accountId: 'account', flowKind: 'live_stream',
                routeKind: 'server_relay', sourceMachineId: 'machine', targetMachineId: 'machine', streamId: 'human',
                streamFamily: 'browser.streamed', sourceId, iat: now, exp: now + 60_000,
                aud: 'happier-live-stream-relay-authorization' },
                signature: { keyId: 'key', alg: 'Ed25519', valueBase64Url: 'AQID' } } }, 'present_user'))
            .toMatchObject({ ok: true });
        await act(async () => root.render(React.createElement(HappierLiveStreamInputLayer, {
            inputAccepted: true, supports: () => true, testID: 'native-viewer', viewport: { width: 800, height: 600 },
            onGesture: ({ eventId, action }) => {
                const event = buildBrowserViewerInput(action);
                if (!event) throw new Error('Expected native key gesture');
                const envelope = MachineLiveStreamDecodedEnvelopeV1Schema.parse({ v: 1,
                    sourceMachineId: 'machine', targetMachineId: 'machine', message: { kind: 'sideband_control', control: {
                        v: 1, kind: 'browser_input', streamId: 'human', sourceId, eventId,
                        controlEpoch: service.getStatus(view).controlEpoch,
                        event: { ...event, target: 'page', sequence: ++sequence },
                    } },
                });
                expect(relay.applyControl(envelope)).toEqual({ ok: true });
            },
        })));
        const capture = container.querySelector<HTMLElement>('[data-testid="native-viewer-capture"]')!;
        const press = async (key: string) => act(async () => {
            capture.focus();
            capture.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
        await evaluate('document.querySelector("#button").focus()');
        await press('Enter');
        await vi.waitFor(async () => expect(await evaluate('window.clicks')).toBe(2));
        await press(' ');
        await vi.waitFor(async () => expect(await evaluate('window.clicks')).toBe(3));
        await evaluate('document.querySelector("#field").focus()');
        await press(' ');
        await vi.waitFor(async () => expect(await evaluate('document.querySelector("#field").value')).toBe(' '));
        await press('Enter');
        await vi.waitFor(async () => expect(await evaluate('window.submits')).toBe(1));
    } finally {
        await act(async () => root.unmount()); container.remove();
        await relay.dispose(); registration.dispose(); await producer.dispose();
        service.dispose(); adapter.dispose(); transport.dispose();
        child.kill('SIGTERM'); await exited;
        await rm(profile, { recursive: true, force: true });
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { HappierLiveStreamInputLayer } from '@happier-dev/plugin-ui/presentation';
import { MachineLiveStreamDecodedEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { buildBrowserViewerInput } from '../../../../../../ui/sources/components/browser/adapters/browserStreamSidebandControl';
import { createMachineLiveStreamCaptureRegistry } from '../../../peer/mediation/stream/captureRegistry';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../../../peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamRelayTerminator } from '../../../peer/mediation/stream/relay';
import { createBrowserCdpScreencastProducer } from '../../capture/cdpScreencast';
import { registerBrowserLiveCapture } from '../../capture/registration';
