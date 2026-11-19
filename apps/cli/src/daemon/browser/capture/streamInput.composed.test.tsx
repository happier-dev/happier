// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { HappierLiveStreamInputLayer } from '@happier-dev/plugin-ui/presentation';
import { MachineLiveStreamDecodedEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { buildBrowserViewerInput, buildBrowserStreamSidebandControl } from '../../../../../ui/sources/components/browser/adapters/browserStreamSidebandControl';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../../peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamRelayTerminator } from '../../peer/mediation/stream/relay';
import { createBrowserCdpScreencastProducer } from './cdpScreencast';
import { registerBrowserLiveCapture } from './registration';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('streamed browser human input composition', () => {
    it('coalesces unpressed hover to one real relayed CDP move per frame and retains click and typing', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
        vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
        const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
        // Chromium is the external boundary; the UI gesture, wire schema, relay and arbitration are real.
        const transport = {
            openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
            dispatchPageCommand: async (command: (typeof commands)[number]) => { commands.push(command); return {}; },
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
                listeners.add(listener); return () => { listeners.delete(listener); };
            },
        };
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'sidecar', transport });
        const contextCapture = { transport, resolvePageHandle: adapter.resolvePageHandle,
            getNavigationState: adapter.getNavigationState, subscribeCdpEvents: transport.subscribeCdpEvents,
            subscribeViewLifecycle: adapter.subscribeViewLifecycle };
        const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter, contextCapture }),
        }) });
        const producer = createBrowserCdpScreencastProducer({ contextCapture });
        const registry = createMachineLiveStreamCaptureRegistry();
        const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation });
        // Production bootstrap passes this registry-backed adapter, rather than the registry itself.
        const relay = createMachineLiveStreamRelayTerminator({ captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry),
            machineId: 'machine', nowMs: Date.now, emitEnvelope: () => {} });
        const admissions: Array<{ ok: true } | { ok: false; reasonCode: string }> = [];
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const sourceId = browserViewKey(view);
        try {
            await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
                target: { kind: 'externalUrl', targetId: 'external', url: 'http://fixture.test' } });
            const now = Date.now();
            expect(await relay.start({ v: 1, streamId: 'human', streamFamily: 'browser.streamed', sourceId,
                sourceMachineId: 'machine', targetMachineId: 'machine', routeKind: 'server_relay',
                authorization: { payload: { v: 1, grantId: 'grant', accountId: 'account', flowKind: 'live_stream',
                    routeKind: 'server_relay', sourceMachineId: 'machine', targetMachineId: 'machine', streamId: 'human',
                    streamFamily: 'browser.streamed', sourceId, iat: now, exp: now + 60_000,
                    aud: 'happier-live-stream-relay-authorization' },
                    signature: { keyId: 'key', alg: 'Ed25519', valueBase64Url: 'AQID' } } }, 'present_user'))
                .toEqual({ ok: true, streamId: 'human' });
            for (const listener of listeners) listener({ method: 'Page.screencastFrame', sessionId: 'cdp-page',
                params: { sessionId: 1, data: 'AQID', metadata: { deviceWidth: 400, deviceHeight: 200 } } });
            await act(async () => root.render(<HappierLiveStreamInputLayer inputAccepted supports={() => true}
                testID="viewer" viewport={{ width: 800, height: 400 }}
                onGesture={({ eventId, action: gesture }) => {
                    const viewerInput = buildBrowserViewerInput(gesture);
                    const control = viewerInput ? { v: 1 as const, kind: 'browser_input' as const, sourceId, streamId: 'human', eventId,
                        controlEpoch: automation.getStatus(view).controlEpoch,
                        event: { ...viewerInput, target: 'page' as const, sequence: admissions.length } }
                        : buildBrowserStreamSidebandControl({ sourceId, streamId: 'human', eventId, gesture });
                    if (control) admissions.push(relay.applyControl(MachineLiveStreamDecodedEnvelopeV1Schema.parse({
                        v: 1, sourceMachineId: 'machine', targetMachineId: 'machine', message: { kind: 'sideband_control', control },
                    })));
                }} />));
            const capture = container.querySelector<HTMLElement>('[data-testid="viewer-capture"]');
            expect(capture).not.toBeNull();
            const pointer = (x: number, pointerType = 'mouse', buttons = 0) => {
                const event = new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: 100, buttons });
                Object.defineProperty(event, 'pointerType', { value: pointerType });
                capture!.dispatchEvent(event);
            };
            await act(async () => {
                for (let x = 1; x <= 100; x++) pointer(x);
                pointer(700, 'touch');
                pointer(750, 'mouse', 1);
            });
            expect(admissions).toHaveLength(0);
            expect(frames).toHaveLength(1);
            await act(async () => frames.shift()!(0));
            expect(admissions).toEqual([{ ok: true }]);
            await vi.waitFor(() => expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent')
                .map(command => command.params)).toEqual([{ type: 'mouseMoved', x: 50, y: 50 }]));
            await act(async () => {
                capture!.focus();
                capture!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 400, clientY: 200 }));
                capture!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 400, clientY: 200 }));
                for (const key of 'HUMAN') capture!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
                capture!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
                capture!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            });
            expect(admissions).toHaveLength(9);
            expect(admissions).toEqual(Array.from({ length: 9 }, () => ({ ok: true })));
            // Space must retain native button activation/scroll semantics rather than
            // inserting text into Chromium's last editable target.
            await vi.waitFor(() => expect(commands).toEqual(expect.arrayContaining([
                expect.objectContaining({ method: 'Input.dispatchKeyEvent', params: expect.objectContaining({
                    type: 'keyDown', key: ' ', windowsVirtualKeyCode: 32,
                }) }),
                expect.objectContaining({ method: 'Input.dispatchKeyEvent', params: expect.objectContaining({ type: 'keyUp', key: ' ' }) }),
            ])));
            await vi.waitFor(() => expect(commands.filter(command => command.method === 'Input.insertText')
                .map(command => command.params?.text).join('')).toBe('HUMAN'));
            expect(commands).toEqual(expect.arrayContaining([
                expect.objectContaining({ method: 'Input.dispatchMouseEvent', params: expect.objectContaining({ type: 'mousePressed', x: 200, y: 100 }) }),
                expect.objectContaining({ method: 'Input.dispatchKeyEvent', params: expect.objectContaining({ key: 'Enter' }) }),
            ]));
            expect(automation.getStatus(view)).toMatchObject({ controller: 'human', controlEpoch: 1 });
        } finally {
            await act(async () => root.unmount()); container.remove();
            await relay.dispose(); registration.dispose(); await producer.dispose(); automation.dispose(); adapter.dispose();
            vi.restoreAllMocks();
        }
    });
});
