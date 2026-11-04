import { createBrowserSidecarInteractions } from '../sidecar/interactions';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { resolveMachineLiveStreamFramePayloadByteLimit } from '@/api/machine/liveStreamFrameBudget';
import { sealMachineLiveStreamEnvelopeV1, openMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import { startMachineLiveStreamFramePump } from '../../peer/mediation/stream/framePump';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createBrowserDaemonRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { createBrowserDaemonFeatureGate } from '../featureGate';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { MachineLiveStreamStartRequestV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { describe, expect, it, vi } from 'vitest';
import type { MachineLiveStreamFrameV1, MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { BrowserEventBatchV1Schema, type BrowserEventBatchV1 } from '@happier-dev/protocol/browser/events/v1';
import { MachineLiveStreamDecodedEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { MachineLiveStreamReceiptV1Schema, type MachineLiveStreamReceiptV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/receipts';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import { createMachineLiveStreamRelayTerminator } from '../../peer/mediation/stream/relay';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../../peer/mediation/stream/captureAdapter';
import { createBrowserCdpScreencastProducer } from './cdpScreencast';
import { registerBrowserLiveCapture } from './registration';
import { registerDaemonLiveStreamRelayHandlers } from '@/rpc/handlers/daemonLiveStreamRelay';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createBrowserAutomationOwnerRegistry } from '../automation/owners';

describe('browser live capture', () => {
    it.each([
        { mode: 'plain', maxFrameBytes: 1024, admitted: true },
        { mode: 'legacy', maxFrameBytes: 1024, admitted: false },
        { mode: 'dataKey', maxFrameBytes: 1024, admitted: false },
        { mode: 'legacy', maxFrameBytes: 2048, admitted: true },
        { mode: 'dataKey', maxFrameBytes: 2048, admitted: true },
    ] as const)('pages binary downloads or explicitly rejects inadequate metadata capacity ($mode, $maxFrameBytes)', async ({ mode, maxFrameBytes, admitted }) => {
        const codec = createMachineContentCodec(mode === 'plain' ? { encryptionMode: 'plain' }
            : { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: mode });
        const content = { mode: codec.mode, ...(codec.mode === 'e2ee' ? { cipher: { encryptRaw: codec.encodeRpc, decryptRaw: codec.decodeRpc } } : {}) };
        const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const pageCommands: string[] = [];
        let downloadPath = '';
        const transport = {
            openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
            dispatchPageCommand: async ({ method }: { method: string }) => {
                pageCommands.push(method);
                return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'frame' } } } : {};
            },
            dispatchBrowserCommand: async ({ params }: { params?: Record<string, unknown> }) => {
                if (typeof params?.downloadPath === 'string') downloadPath = params.downloadPath;
                return { success: true };
            },
            subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
                listeners.add(listener); return () => { listeners.delete(listener); };
            },
        };
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar', transport });
        const interactions = createBrowserSidecarInteractions({ transport, resolvePageHandle: adapter.resolvePageHandle,
            subscribeViewLifecycle: adapter.subscribeViewLifecycle });
        const contextCapture = { resolveViewportOwner: () => adapter.viewportOwner, transport, interactions, resolvePageHandle: adapter.resolvePageHandle,
            getNavigationState: adapter.getNavigationState, subscribeBrowserEvents: adapter.subscribeBrowserEvents,
            subscribeCdpEvents: transport.subscribeCdpEvents, subscribeViewLifecycle: adapter.subscribeViewLifecycle };
        const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter, contextCapture }),
        }) });
        const registry = createMachineLiveStreamCaptureRegistry();
        const producer = createBrowserCdpScreencastProducer({ contextCapture });
        const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation });
        let stop: (() => void | Promise<void>) | undefined;
        try {
            await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
                target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
            await vi.waitFor(() => expect(downloadPath).not.toBe(''));
            const bytes = Buffer.from(Array.from({ length: 8192 }, (_, i) => i % 256));
            await writeFile(join(downloadPath, 'dl'), bytes);
            for (const listener of listeners) listener({ method: 'Browser.downloadWillBegin', params: { guid: 'dl', frameId: 'frame', suggestedFilename: 'binary.dat' } });
            for (const listener of listeners) listener({ method: 'Browser.downloadProgress', params: { guid: 'dl', state: 'completed', receivedBytes: bytes.length, totalBytes: bytes.length } });
            const sourceId = browserViewKey(view);
            const source = registry.resolve({ sourceId, streamFamily: 'browser.streamed' });
            if (!source.ok) throw new Error('capture source missing');
            const streamId = 'download-viewer';
            const startRequest = MachineLiveStreamStartRequestV1Schema.parse({ v: 1, streamId, sourceId, streamFamily: 'browser.streamed',
                sourceMachineId: 'machine', targetMachineId: 'viewer', routeKind: 'loopback_direct', maxFrameBytes });
            const results: BrowserEventBatchV1[] = [];
            const frameSizes: Array<{ bytes: number; facts: string[] }> = [];
            const receipts: MachineLiveStreamReceiptV1[] = [];
            const sealedFrames: Promise<void>[] = [];
            const envelope = (frame: MachineLiveStreamFrameV1): MachineLiveStreamRelayEnvelopeV1 => ({
                v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer', message: { kind: 'frame', frame },
            });
            const pump = startMachineLiveStreamFramePump({ streamId, caps: { maxFrameBytes }, startedAtMs: Date.now(), nowMs: Date.now,
                emitReceipt: receipt => { receipts.push(receipt); }, emitFrame: frame => {
                    if (frame.payloadKind === 'metadata') {
                        const batch = BrowserEventBatchV1Schema.parse(JSON.parse(Buffer.from(frame.payloadBase64, 'base64').toString('utf8')));
                        results.push(batch);
                        sealedFrames.push((async () => {
                            const sealed = await sealMachineLiveStreamEnvelopeV1(envelope(frame), content);
                            if (!sealed.ok || sealed.value.message.kind !== 'frame') throw new Error('seal failed');
                            frameSizes.push({ bytes: sealed.value.message.frame.payloadSizeBytes,
                                facts: [...batch.events.map(event => event.kind), ...Object.keys(batch).filter(key => key !== 'v' && key !== 'events')] });
                            expect(await openMachineLiveStreamEnvelopeV1(sealed.value, content)).toEqual({ ok: true, value: envelope(frame) });
                        })());
                    }
                } });
            const listenersBeforeStart = listeners.size;
            const started = await source.source.adapter.start({ streamId, callerAuthority: 'present_user', startRequest,
                streamFamily: 'browser.streamed', sourceMachineId: 'machine', targetMachineId: 'viewer', caps: { maxFrameBytes },
                startedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, nowMs: Date.now, applyControl: pump.applyControl,
                emitReceipt: receipt => { receipts.push(receipt); }, offerFrame: pump.offerFrame,
                getFramePayloadByteLimit: frame => resolveMachineLiveStreamFramePayloadByteLimit({ envelope: envelope(frame), maxFrameBytes, codec }) });
            if (!admitted) {
                await Promise.all(sealedFrames);
                expect({ started, frameSizes }).toEqual({ started: { ok: false, reasonCode: 'max_frame_bytes_exceeded' }, frameSizes: [] });
                expect(receipts).toMatchObject([{ reasonCode: 'max_frame_bytes_exceeded', terminal: true }]);
                expect(pageCommands.filter(method => method === 'Page.startScreencast' || method === 'Page.stopScreencast'))
                    .toEqual(['Page.startScreencast', 'Page.stopScreencast']);
                expect(listeners.size).toBe(listenersBeforeStart);
                return;
            }
            if (!started.ok) throw new Error('capture did not start');
            stop = started.session.stop;
            const chunks: Buffer[] = [];
            let offset = 0;
            for (let sequence = 0; ; sequence++) {
                const eventId = `download:${sequence}`;
                expect(started.session.applySidebandControl?.({ v: 1, kind: 'browser_input', sourceId, streamId, eventId,
                    controlEpoch: automation.getStatus(view).controlEpoch,
                    event: { kind: 'download', target: 'page', sequence, downloadId: 'dl', offset, byteLength: maxFrameBytes } }).ok).toBe(true);
                await vi.waitFor(() => expect(results.some(batch => batch.inputResult?.automationRequestId === eventId)).toBe(true));
                const result = results.find(batch => batch.inputResult?.automationRequestId === eventId)?.inputResult?.interactionResult;
                expect(result?.kind).toBe('download');
                if (result?.kind !== 'download') throw new Error('download result missing');
                expect(result.offset).toBe(offset);
                const chunk = Buffer.from(result.dataBase64, 'base64');
                chunks.push(chunk);
                offset += chunk.length;
                if (result.eof) break;
                expect(chunk.length).toBeGreaterThan(0);
            }
            expect(chunks.length).toBeGreaterThan(1);
            expect(Buffer.concat(chunks)).toEqual(bytes);
            await Promise.all(sealedFrames);
            expect(frameSizes.filter(frame => frame.bytes > maxFrameBytes)).toEqual([]);
            expect(receipts).toEqual([]);
            const deliveredFrames = frameSizes.length;
            for (const listener of [...listeners]) listener({ method: 'Page.javascriptDialogOpening', sessionId: 'cdp-page',
                params: { type: 'alert', message: 'x'.repeat(maxFrameBytes) } });
            await vi.waitFor(() => {
                expect(receipts).toMatchObject([{ reasonCode: 'max_frame_bytes_exceeded', terminal: true }]);
                expect(pageCommands.filter(method => method === 'Page.startScreencast' || method === 'Page.stopScreencast'))
                    .toEqual(['Page.startScreencast', 'Page.stopScreencast']);
                expect(listeners.size).toBe(listenersBeforeStart);
            });
            expect(frameSizes).toHaveLength(deliveredFrames);
            expect(started.session.applyControl?.({ v: 1, streamId, kind: 'resume' }))
                .toEqual({ ok: false, reasonCode: 'capture_stopped' });
        } finally { await stop?.(); registration.dispose(); await interactions.dispose(); await producer.dispose(); }
    });
    it.each(['controller', 'navigation', 'interaction'] as const)('publishes only the changed %s fact between startup and recovery snapshots', async change => {
        const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
        // Chromium is the only substituted boundary; metadata reaches the real stream codec.
        const transport = {
            openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
            dispatchPageCommand: async () => ({}),
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
                listeners.add(listener); return () => { listeners.delete(listener); };
            },
        };
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar', transport });
        const interactions = createBrowserSidecarInteractions({ transport, resolvePageHandle: adapter.resolvePageHandle,
            subscribeViewLifecycle: adapter.subscribeViewLifecycle });
        const contextCapture = { resolveViewportOwner: () => adapter.viewportOwner, transport, interactions, resolvePageHandle: adapter.resolvePageHandle,
            getNavigationState: adapter.getNavigationState, subscribeBrowserEvents: adapter.subscribeBrowserEvents,
            subscribeCdpEvents: transport.subscribeCdpEvents, subscribeViewLifecycle: adapter.subscribeViewLifecycle };
        const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter, contextCapture }),
        }) });
        const producer = createBrowserCdpScreencastProducer({ contextCapture });
        const registry = createMachineLiveStreamCaptureRegistry();
        const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation });
        const metadata: BrowserEventBatchV1[] = [];
        const sourceId = browserViewKey(view);
        let stop: (() => void | Promise<void>) | undefined;
        try {
            await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
                target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
            const source = registry.resolve({ sourceId, streamFamily: 'browser.streamed' });
            if (!source.ok) throw new Error('fixture capture source missing');
            const startRequest = MachineLiveStreamStartRequestV1Schema.parse({ v: 1, streamId: 'human', sourceId,
                streamFamily: 'browser.streamed', sourceMachineId: 'machine', targetMachineId: 'viewer', routeKind: 'loopback_direct' });
            const result = await source.source.adapter.start({ streamId: 'human', callerAuthority: 'present_user', startRequest,
                streamFamily: 'browser.streamed', sourceMachineId: 'machine', targetMachineId: 'viewer', caps: {},
                startedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, nowMs: Date.now,
                offerFrame: frame => {
                    if (frame.payloadKind === 'metadata') metadata.push(BrowserEventBatchV1Schema.parse(
                        JSON.parse(Buffer.from(frame.payloadBase64, 'base64').toString('utf8'))));
                    return { ok: true };
                }, applyControl: () => ({ ok: true }), emitReceipt: () => {} });
            if (!result.ok) throw new Error('fixture capture failed');
            stop = () => result.session.stop();
            const expectSnapshot = () => {
                expect(metadata).toHaveLength(1);
                expect(metadata[0].events.map(event => event.kind)).toEqual(['navigationStateChanged', 'controllerChanged']);
                expect(metadata[0].interactionState).toEqual(interactions.getState(view));
                expect(metadata[0].viewerInput).toEqual({ controlling: false, controlEpoch: automation.getStatus(view).controlEpoch });
            };
            expectSnapshot();
            metadata.length = 0;
            if (change === 'controller') {
                await automation.recordHumanInput({ ...view, authority: 'present_user' });
                expect(metadata).toHaveLength(1);
                expect(metadata[0].events).toEqual([expect.objectContaining({ kind: 'controllerChanged',
                    state: expect.objectContaining({ controller: 'human' }) })]);
                expect(Object.keys(metadata[0]).sort()).toEqual(['events', 'v', 'viewerInput']);
            } else if (change === 'navigation') {
                for (const listener of [...listeners]) listener({ method: 'Page.frameNavigated', sessionId: 'cdp-page',
                    params: { frame: { id: 'main', loaderId: 'next-document', url: 'https://example.test/next' } } });
                expect(metadata).toHaveLength(1);
                expect(metadata[0].events).toEqual([expect.objectContaining({ kind: 'navigationStateChanged',
                    currentUrl: 'https://example.test/next', navigationGeneration: 1 })]);
                expect(Object.keys(metadata[0]).sort()).toEqual(['events', 'v']);
            } else {
                for (const listener of [...listeners]) listener({ method: 'Page.javascriptDialogOpening', sessionId: 'cdp-page',
                    params: { type: 'confirm', message: 'Continue?' } });
                expect(metadata).toHaveLength(1);
                expect(metadata[0]).toEqual({ v: 1, events: [], interactionState: expect.objectContaining({
                    dialog: expect.objectContaining({ type: 'confirm', message: 'Continue?' }),
                }) });
            }
            for (const control of [{ kind: 'keyframe_required', reasonCode: 'viewer_request' }, { kind: 'resume' }] as const) {
                metadata.length = 0;
                expect(result.session.applyControl?.({ v: 1, streamId: 'human', ...control })).toEqual({ ok: true });
                expectSnapshot();
            }
        } finally {
            await stop?.(); registration.dispose(); await producer.dispose(); automation.dispose(); adapter.dispose(); await interactions.dispose();
        }
    });

    it('lets the controlling viewer resize once per geometry change and returns value-free keyboard hints', async () => {
        const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
        const transport = {
            openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
            dispatchPageCommand: async (command: (typeof commands)[number]) => {
                commands.push(command);
                if (command.params?.expression === 'navigator.userAgent') return { result: { value: 'Mozilla/5.0 Chrome/142.0.7444.0 Safari/537.36' } };
                if (command.method === 'Runtime.evaluate') return { result: { value: {
                    editable: true, inputMode: 'email', multiline: false, secret: false,
                } } };
                return {};
            },
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
                listeners.add(listener); return () => { listeners.delete(listener); };
            },
        };
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar', transport });
        const contextCapture = { resolveViewportOwner: () => adapter.viewportOwner, transport, resolvePageHandle: adapter.resolvePageHandle,
            getNavigationState: adapter.getNavigationState, subscribeBrowserEvents: adapter.subscribeBrowserEvents,
            subscribeCdpEvents: transport.subscribeCdpEvents, subscribeViewLifecycle: adapter.subscribeViewLifecycle };
        const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter, contextCapture }),
        }) });
        const producer = createBrowserCdpScreencastProducer({ contextCapture });
        const registry = createMachineLiveStreamCaptureRegistry();
        const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation });
        const frames: Array<{ streamId: string; payloadBase64: string; payloadKind?: string }> = [];
        const sourceId = browserViewKey(view);
        try {
            await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
                target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
            const source = registry.resolve({ sourceId, streamFamily: 'browser.streamed' });
            expect(source.ok).toBe(true);
            if (!source.ok) return;
            const start = async (streamId: string, callerAuthority: 'present_user' | 'account_automation') => {
                const startRequest = MachineLiveStreamStartRequestV1Schema.parse({ v: 1, streamId, sourceId,
                    streamFamily: 'browser.streamed', sourceMachineId: 'machine', targetMachineId: 'viewer', routeKind: 'loopback_direct' });
                const result = await source.source.adapter.start({ streamId, callerAuthority, startRequest,
                    streamFamily: 'browser.streamed', sourceMachineId: 'machine', targetMachineId: 'viewer', caps: {},
                    startedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, nowMs: Date.now,
                    offerFrame: frame => { frames.push(frame); return { ok: true }; },
                    applyControl: () => ({ ok: true }), emitReceipt: () => {} });
                expect(result.ok).toBe(true);
                if (!result.ok) throw new Error('fixture capture failed');
                return result.session;
            };
            const controller = await start('controller', 'present_user');
            const observer = await start('observer', 'present_user');
            const agent = await start('agent', 'account_automation');
            const send = (session: typeof controller, streamId: string, event: unknown, eventId: string) => {
                const parsed = MachineLiveStreamDecodedEnvelopeV1Schema.safeParse({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer',
                    message: { kind: 'sideband_control', control: { v: 1, streamId, sourceId, eventId, kind: 'browser_input',
                        controlEpoch: automation.getStatus(view).controlEpoch, event } } });
                expect(parsed.success).toBe(true);
                if (!parsed.success || parsed.data.message.kind !== 'sideband_control') throw new Error('viewport control rejected');
                return session.applySidebandControl?.(parsed.data.message.control);
            };
            const viewport = { kind: 'viewport', target: 'page', width: 390, height: 844, deviceScaleFactor: 3, sequence: 1 };
            expect(send(controller, 'controller', viewport, 'size-1')).toEqual({ ok: true });
            await vi.waitFor(() => expect(commands.filter(c => c.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1));
            expect(send(controller, 'controller', { ...viewport, sequence: 2 }, 'same')).toEqual({ ok: true });
            expect(send(observer, 'observer', { ...viewport, width: 1440 }, 'observer-size')).toEqual({ ok: false, reasonCode: 'viewer_not_controlling' });
            expect(send(agent, 'agent', viewport, 'agent-size')).toEqual({ ok: false, reasonCode: 'input_not_supported' });
            expect(send(controller, 'controller', { ...viewport, height: 400, sequence: 3 }, 'size-2')).toEqual({ ok: true });
            expect(send(controller, 'controller', { kind: 'editableProbe', target: 'page', x: 0.5, y: 0.25, sequence: 4 }, 'probe')).toEqual({ ok: true });
            await vi.waitFor(() => expect(commands.filter(c => c.method === 'Runtime.evaluate')).toHaveLength(1));
            expect(commands.filter(c => c.method === 'Emulation.setDeviceMetricsOverride').map(c => c.params)).toEqual([
                { width: 390, height: 844, deviceScaleFactor: 3, mobile: false },
                { width: 390, height: 400, deviceScaleFactor: 3, mobile: false },
            ]);
            await vi.waitFor(() => {
                const metadata = frames.filter(frame => frame.payloadKind === 'metadata').map(frame => ({ streamId: frame.streamId,
                    batch: BrowserEventBatchV1Schema.parse(JSON.parse(Buffer.from(frame.payloadBase64, 'base64').toString('utf8'))) }));
                expect(metadata).toContainEqual(expect.objectContaining({ streamId: 'controller', batch: expect.objectContaining({
                    editableTarget: { editable: true, inputMode: 'email', multiline: false, secret: false },
                }) }));
                expect(metadata.filter(frame => frame.streamId !== 'controller').every(frame => !('editableTarget' in frame.batch))).toBe(true);
                expect(metadata.filter(frame => frame.batch.viewerInput?.controlling).every(frame => frame.batch.events.some(event =>
                    event.kind === 'controllerChanged' && event.state.controller === 'human'))).toBe(true);
            });
            const broker = createBrowserDaemonControlBroker();
            broker.registerAdapter(adapter);
            const routes = createBrowserDaemonControlRoutes({ broker, automation: () => automation });
            const featureGate = createBrowserDaemonFeatureGate({ env: { NODE_ENV: 'test' }, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
                features: FeaturesResponseSchema.parse({ features: { browser: { enabled: true,
                    viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } } } }),
            }) });
            await featureGate.refresh();
            const execute = createBrowserDaemonRuntimeActionExecutor({ control: routes, featureGate });
            const setEmulation = (emulation: { kind: 'preset'; presetId: 'phone' } | { kind: 'fitViewer' }) => execute({
                actionId: 'browser.view.setViewport', context: { authority: 'present_user' },
                input: { kind: 'setViewport', commandId: `emulate-${emulation.kind}`, ...view, emulation },
            });
            expect(await setEmulation({ kind: 'preset', presetId: 'phone' })).toMatchObject({ status: 'dispatched' });
            const count = commands.filter(command => command.method === 'Emulation.setDeviceMetricsOverride').length;
            expect(send(controller, 'controller', { ...viewport, width: 800, height: 600, sequence: 5 }, 'resize-preset')).toEqual({ ok: true });
            // A preset retains the same public geometry, so that fact cannot acknowledge the
            // queued resize. Observe a subsequent page probe before issuing another Action.
            expect(send(controller, 'controller', { kind: 'editableProbe', target: 'page', x: 0.5, y: 0.25, sequence: 6 }, 'preset-probe')).toEqual({ ok: true });
            await vi.waitFor(() => expect(commands.filter(command => command.method === 'Runtime.evaluate')).toHaveLength(3));
            await vi.waitFor(() => expect(adapter.viewportOwner.getViewport(view)).toMatchObject({ width: 412, height: 839,
                deviceScaleFactor: 2.625, emulation: { kind: 'preset', presetId: 'phone' } }));
            expect(commands.filter(command => command.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(count);
            const metadata = frames.filter(frame => frame.payloadKind === 'metadata').map(frame => ({ streamId: frame.streamId,
                batch: BrowserEventBatchV1Schema.parse(JSON.parse(Buffer.from(frame.payloadBase64, 'base64').toString('utf8'))) }));
            for (const streamId of ['controller', 'observer', 'agent']) expect(metadata).toContainEqual(expect.objectContaining({ streamId,
                batch: expect.objectContaining({ viewport: expect.objectContaining({ width: 412, height: 839,
                    emulation: { kind: 'preset', presetId: 'phone' } }) }) }));
            expect(await setEmulation({ kind: 'fitViewer' })).toMatchObject({ status: 'dispatched' });
            expect(adapter.viewportOwner.getViewport(view)).toMatchObject({ width: 800, height: 600, deviceScaleFactor: 3,
                emulation: { kind: 'fitViewer' } });
            await controller.stop(); await observer.stop(); await agent.stop();
        } finally { registration.dispose(); await producer.dispose(); automation.dispose(); adapter.dispose(); }
    });

    it('holds the triggering and subsequent human sideband after uncertain takeover until fresh observation', async () => {
        const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const commands: string[] = [];
        let rejectAck: (error: Error) => void = () => undefined;
        let inputStarted: () => void = () => undefined;
        const started = new Promise<void>(resolve => { inputStarted = resolve; });
        const pendingAck = new Promise<unknown>((_resolve, reject) => { rejectAck = reject; });
        // Only the CDP peer is substituted; all source, sideband, service and control owners are real.
        const transport = {
            openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
            dispatchPageCommand: async (command: { method: string; params?: Record<string, unknown> }) => {
                if (command.method === 'Input.insertText') {
                    commands.push(String(command.params?.text));
                    if (command.params?.text === 'agent effect') { inputStarted(); return pendingAck; }
                }
                return command.method === 'Runtime.evaluate' ? { result: { type: 'string', value: 'safe page' } } : {};
            },
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
                listeners.add(listener); return () => { listeners.delete(listener); };
            },
        };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar', transport });
        const contextCapture = { transport, resolvePageHandle: adapter.resolvePageHandle,
            getNavigationState: adapter.getNavigationState, subscribeCdpEvents: transport.subscribeCdpEvents,
            subscribeViewLifecycle: adapter.subscribeViewLifecycle };
        const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter, contextCapture }),
        }) });
        const producer = createBrowserCdpScreencastProducer({ contextCapture });
        const registry = createMachineLiveStreamCaptureRegistry();
        const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation });
        const envelopes: MachineLiveStreamRelayEnvelopeV1[] = [];
        const relay = createMachineLiveStreamRelayTerminator({ captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry), machineId: 'machine', nowMs: Date.now,
            emitEnvelope: envelope => { envelopes.push(envelope); } });
        try {
            await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
                target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
            const sourceId = browserViewKey(view);
            expect(await relay.start({ v: 1, streamId: 'human', streamFamily: 'browser.streamed', sourceId,
                sourceMachineId: 'machine', targetMachineId: 'viewer', routeKind: 'server_relay',
                authorization: { payload: { v: 1, grantId: 'grant', accountId: 'account', flowKind: 'live_stream',
                    routeKind: 'server_relay', sourceMachineId: 'machine', targetMachineId: 'viewer', streamId: 'human',
                    streamFamily: 'browser.streamed', sourceId, iat: Date.now(), exp: Date.now() + 60_000,
                    aud: 'happier-live-stream-relay-authorization' },
                    signature: { keyId: 'key', alg: 'Ed25519', valueBase64Url: 'AQID' } } }, 'present_user'))
                .toEqual({ ok: true, streamId: 'human' });
            const input = (eventId: string) => relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer',
                message: { kind: 'sideband_control', control: { v: 1, streamId: 'human', sourceId,
                    eventId, kind: 'keyboard_text', text: eventId } } });
            const request = { v: 1 as const, ...view, navigationGeneration: 0, timeoutMs: 10_000,
                requesterRef: { kind: 'agent' as const, id: 'agent' } };
            const agent = automation.execute({ ...request, automationRequestId: 'agent', requestedBy: 'agent',
                actionKind: 'type', payload: { text: 'agent effect' } });
            await started;
            expect(input('trigger')).toEqual({ ok: true });
            rejectAck(new Error('acknowledgement lost'));
            expect(await agent).toMatchObject({ status: 'canceled', resultSummary: { completion: 'uncertain' } });
            await vi.waitFor(() => expect(automation.getStatus(view)).toMatchObject({ controller: 'human', uncertain: true }));
            expect(input('next')).toEqual({ ok: true });
            await vi.waitFor(() => expect(automation.getTimeline(view).entries.some(entry => entry.automationRequestId === 'next')).toBe(true));
            expect(commands).toEqual(['agent effect']);
            expect(envelopes.map(envelope => MachineLiveStreamDecodedEnvelopeV1Schema.parse(envelope))
                .filter(envelope => envelope.message.kind === 'receipt'
                    && MachineLiveStreamReceiptV1Schema.parse(envelope.message.receipt).terminal === false)).toHaveLength(2);
            expect(await automation.recordHumanInput({ ...view, authority: 'present_user' }))
                .toEqual({ ok: true, completion: 'uncertain' });
            expect(await automation.execute({ ...request, automationRequestId: 'observe', requestedBy: 'user',
                actionKind: 'snapshot', payload: {} })).toMatchObject({ status: 'succeeded' });
            expect(automation.getStatus(view).uncertain).toBe(false);
            expect(input('recovered')).toEqual({ ok: true });
            await vi.waitFor(() => expect(commands).toEqual(['agent effect', 'recovered']));
        } finally { await relay.dispose(); registration.dispose(); await producer.dispose(); automation.dispose(); adapter.dispose(); }
    });
    it('preserves only the verified human RPC viewer while a confidential view is held', async () => {
        const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const owners = createBrowserAutomationOwnerRegistry();
        const control = owners.getInputControl(view);
        const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
        // Only the Chromium/CDP transport is substituted; all admission and capture owners are real.
        const transport = {
            openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
            dispatchPageCommand: async (command: (typeof commands)[number]) => { commands.push(command); return {}; },
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
                listeners.add(listener); return () => { listeners.delete(listener); };
            },
        };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar',
            transport, resolveInputControl: () => control });
        const contextCapture = { transport, resolvePageHandle: adapter.resolvePageHandle,
            getNavigationState: adapter.getNavigationState, subscribeBrowserEvents: adapter.subscribeBrowserEvents,
            subscribeCdpEvents: transport.subscribeCdpEvents, subscribeViewLifecycle: adapter.subscribeViewLifecycle };
        const automation = createBrowserAutomationDaemonService({ owners, adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter, contextCapture }),
        }) });
        const producer = createBrowserCdpScreencastProducer({ contextCapture, resolveInputControl: () => control });
        const registry = createMachineLiveStreamCaptureRegistry();
        const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation,
            resolveInputControl: () => control });
        const envelopes: MachineLiveStreamRelayEnvelopeV1[] = [];
        const relay = createMachineLiveStreamRelayTerminator({ captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry), machineId: 'machine', nowMs: () => 1_000,
            emitEnvelope: envelope => {
                envelopes.push(envelope);
                if (envelope.message.kind === 'frame') relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer',
                    message: { kind: 'control', control: { v: 1, streamId: envelope.message.frame.streamId, kind: 'ack',
                        nextSequence: envelope.message.frame.sequence + 1 } } });
            } });
        // Registration is the RPC boundary; handlers validate their own request schemas.
        const handlers = new Map<string, RpcHandler>();
        registerDaemonLiveStreamRelayHandlers({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
            relay: { start: (request, authority?: RpcHandlerContext['callerAuthority']) => relay.start(request, authority) },
        });
        const sourceId = browserViewKey(view);
        const start = (streamId: string, callerAuthority?: RpcHandlerContext['callerAuthority']) => {
            const startRequest = { v: 1 as const, streamId, streamFamily: 'browser.streamed', sourceId,
                sourceMachineId: 'machine', targetMachineId: 'viewer', routeKind: 'server_relay' as const,
                // This untrusted payload claim must never confer the human-viewer exemption.
                callerAuthority: 'present_user',
                authorization: { payload: { v: 1 as const, grantId: `grant:${streamId}`, accountId: 'account',
                    flowKind: 'live_stream' as const, routeKind: 'server_relay' as const,
                    sourceMachineId: 'machine', targetMachineId: 'viewer', streamId, streamFamily: 'browser.streamed',
                    sourceId, iat: 1_000, exp: 61_000, aud: 'happier-live-stream-relay-authorization' as const },
                    signature: { keyId: 'key', alg: 'Ed25519' as const, valueBase64Url: 'AQID' } } };
            return handlers.get(RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START)?.({ protocolVersion: 1,
                machineId: 'machine', startRequest }, callerAuthority
                ? { signal: new AbortController().signal, callerAuthority } : undefined);
        };
        try {
            await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
                target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
            for (const [streamId, authority] of [['human', 'present_user'], ['automation', 'account_automation'], ['missing', undefined]] as const) {
                expect(await start(streamId, authority)).toMatchObject({ result: { ok: true, streamId } });
            }
            for (const listener of [...listeners]) listener({ method: 'Page.screencastFrame', sessionId: 'cdp-page',
                params: { sessionId: 0, data: 'AQID', metadata: { deviceWidth: 400, deviceHeight: 200 } } });
            envelopes.length = 0;
            await control.beginConfidentialityHold();
            const material = 'D26-HUMAN-VIEW-METADATA-UNIQUE';
            for (const listener of [...listeners]) listener({ method: 'Target.targetInfoChanged',
                params: { targetInfo: { targetId: 'page', title: material } } });
            for (const listener of [...listeners]) listener({ method: 'Page.frameNavigated', sessionId: 'cdp-page',
                params: { frame: { id: 'frame', loaderId: 'submitted', url: `https://example.test/?credential=${material}` } } });
            const metadata = envelopes.flatMap(envelope => envelope.message.kind === 'frame'
                && envelope.message.frame.payloadKind === 'metadata' ? [{ streamId: envelope.message.frame.streamId,
                    events: BrowserEventBatchV1Schema.parse(JSON.parse(Buffer.from(envelope.message.frame.payloadBase64, 'base64').toString('utf8'))).events,
                }] : []);
            expect(metadata.some(frame => frame.streamId === 'human' && JSON.stringify(frame.events).includes(material))).toBe(true);
            expect(metadata.filter(frame => frame.streamId !== 'human')).toEqual([]);
            for (const listener of [...listeners]) listener({ method: 'Page.screencastFrame', sessionId: 'cdp-page',
                params: { sessionId: 1, data: 'cHJpdmF0ZQ==', metadata: { deviceWidth: 400, deviceHeight: 200 } } });
            expect(envelopes.flatMap(envelope => envelope.message.kind === 'frame'
                && envelope.message.frame.payloadKind !== 'metadata' ? [envelope.message.frame.streamId] : [])).toEqual(['human']);
            expect(await start('held-automation', 'account_automation')).toMatchObject({ result: { ok: false } });
            expect(await start('held-missing')).toMatchObject({ result: { ok: false } });
            const type = (streamId: string) => relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer',
                message: { kind: 'sideband_control', control: { v: 1, streamId, sourceId, eventId: `input:${streamId}`,
                    kind: 'keyboard_text', text: `input:${streamId}` } } });
            expect(type('automation')).toEqual({ ok: false, reasonCode: 'input_not_supported' });
            expect(type('missing')).toEqual({ ok: false, reasonCode: 'input_not_supported' });
            expect(commands.filter(command => command.method === 'Input.insertText')).toEqual([]);
            expect(type('human')).toEqual({ ok: true });
            await vi.waitFor(() => expect(commands.filter(command => command.method === 'Input.insertText'))
                .toEqual([expect.objectContaining({ params: { text: 'input:human' } })]));
        } finally {
            await relay.dispose(); registration.dispose(); await producer.dispose(); automation.dispose(); adapter.dispose();
        }
    });
    it('streams the exact owned view and routes viewer input through human takeover without a simulator lease', async () => {
        const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
        let failInput = false;
        // Chromium/CDP is the system boundary; capture, registry, codec/credit admission and
        // automation/controller arbitration below it are real owners.
        const transport = {
            openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
            dispatchPageCommand: async (command: (typeof commands)[number]) => {
                commands.push(command);
                if (failInput && command.method === 'Input.insertText') throw new Error('native input failed');
                return {};
            },
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
                listeners.add(listener); return () => { listeners.delete(listener); };
            },
        };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar', transport });
        const contextCapture = { transport, resolvePageHandle: adapter.resolvePageHandle,
            subscribeCdpEvents: transport.subscribeCdpEvents, subscribeViewLifecycle: adapter.subscribeViewLifecycle,
            subscribeBrowserEvents: adapter.subscribeBrowserEvents, getNavigationState: adapter.getNavigationState };
        const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter, contextCapture }),
        }) });
        const resolveInputControl = (view: { browserSessionId: string; viewId: string }) => automation.getInputControl(view);
        const producer = createBrowserCdpScreencastProducer({ contextCapture, resolveInputControl });
        const registry = createMachineLiveStreamCaptureRegistry();
        const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation, resolveInputControl });
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const sourceId = browserViewKey(view);
        const envelopes: MachineLiveStreamRelayEnvelopeV1[] = [];
        const browserEvents = () => envelopes.flatMap(envelope => envelope.message.kind === 'frame'
            && envelope.message.frame.payloadKind === 'metadata'
            ? BrowserEventBatchV1Schema.parse(JSON.parse(Buffer.from(envelope.message.frame.payloadBase64, 'base64').toString('utf8'))).events : []);
        const relay = createMachineLiveStreamRelayTerminator({ captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry), machineId: 'machine', nowMs: Date.now,
            emitEnvelope: envelope => {
                envelopes.push(envelope);
                if (envelope.message.kind === 'frame') relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer',
                    message: { kind: 'control', control: { v: 1, streamId: envelope.message.frame.streamId, kind: 'ack', nextSequence: envelope.message.frame.sequence + 1 } } });
            } });
        try {
            await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
                target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
            const source = registry.resolve({ sourceId, streamFamily: 'browser.streamed' });
            expect(source.ok).toBe(true);
            if (!source.ok) return;
            const start = { v: 1 as const, streamId: 'stream', streamFamily: 'browser.streamed', sourceId,
                sourceMachineId: 'machine', targetMachineId: 'viewer', routeKind: 'server_relay' as const,
                authorization: { payload: { v: 1 as const, grantId: 'grant', accountId: 'account', flowKind: 'live_stream' as const,
                    routeKind: 'server_relay' as const, sourceMachineId: 'machine', targetMachineId: 'viewer',
                    streamId: 'stream', streamFamily: 'browser.streamed', sourceId, iat: Date.now(), exp: Date.now() + 60_000,
                    aud: 'happier-live-stream-relay-authorization' as const },
                    signature: { keyId: 'key', alg: 'Ed25519' as const, valueBase64Url: 'AQID' } } };
            // Signature authentication belongs to server ingress. This test exercises the actual
            // daemon terminator, registry, frame pump and controller under its admitted contract.
            expect(await relay.start(start, 'present_user')).toEqual({ ok: true, streamId: 'stream' });
            for (const listener of [...listeners]) listener({ method: 'Page.screencastFrame', sessionId: 'cdp-page',
                params: { sessionId: 1, data: 'AQID', metadata: { deviceWidth: 400, deviceHeight: 200 } } });
            expect(envelopes.filter(envelope => envelope.message.kind === 'frame' && envelope.message.frame.payloadKind !== 'metadata')).toMatchObject([
                { message: { frame: { streamId: 'stream', sequence: expect.any(Number), payloadBase64: 'AQID', codecId: 'image.mjpeg' } } },
            ]);
            // A second tab or a remounted viewer joins the same static page: Chromium need not
            // repaint, and restarting its shared screencast would disrupt the existing viewer.
            const lateStart = { ...start, streamId: 'late-human', authorization: { ...start.authorization,
                payload: { ...start.authorization.payload, streamId: 'late-human' } } };
            expect(await relay.start(lateStart, 'present_user')).toEqual({ ok: true, streamId: 'late-human' });
            const lateImage = envelopes.find(envelope => envelope.message.kind === 'frame'
                && envelope.message.frame.streamId === 'late-human' && envelope.message.frame.payloadKind === 'image_keyframe');
            expect(lateImage).toBeDefined();
            expect(MachineLiveStreamDecodedEnvelopeV1Schema.parse(lateImage)).toMatchObject({ message: { frame: {
                streamId: 'late-human', payloadBase64: 'AQID', codecId: 'image.mjpeg',
            } } });
            expect(commands.filter(command => command.method === 'Page.startScreencast')).toHaveLength(1);
            expect(commands.filter(command => command.method === 'Page.screencastFrameAck')).toHaveLength(1);
            expect(browserEvents()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'controllerChanged', state: expect.objectContaining({ controller: 'none' }) })]));
            for (const listener of [...listeners]) listener({ method: 'Page.frameNavigated', sessionId: 'cdp-page',
                params: { frame: { id: 'main', loaderId: 'next-document', url: 'https://example.test/next' } } });
            expect(browserEvents()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'navigationStateChanged', currentUrl: 'https://example.test/next', navigationGeneration: 1 })]));
            expect(relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer', message: {
                kind: 'sideband_control', control: { v: 1, streamId: 'stream', sourceId, eventId: 'click', kind: 'tap', x: 0.5, y: 0.5 },
            } })).toEqual({ ok: true });
            await vi.waitFor(() => expect(automation.getTimeline(view).entries.map(({ status, reasonCode }) => ({ status, reasonCode })))
                .toEqual([{ status: 'succeeded', reasonCode: undefined }]));
            await vi.waitFor(() => expect(commands).toEqual(expect.arrayContaining([
                expect.objectContaining({ method: 'Input.dispatchMouseEvent', params: expect.objectContaining({ type: 'mousePressed', x: 200, y: 100 }) }),
            ])));
            expect(automation.getStatus(view).controller).toBe('human');
            expect(browserEvents()).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'controllerChanged', ...view, state: expect.objectContaining({ controller: 'human', controlEpoch: 1 }) }),
            ]));
            for (const control of [
                { v: 1 as const, streamId: 'stream', sourceId, eventId: 'type', kind: 'keyboard_text' as const, text: 'hello' },
                { v: 1 as const, streamId: 'stream', sourceId, eventId: 'scroll', kind: 'swipe' as const,
                    fromX: 0.5, fromY: 0.75, toX: 0.5, toY: 0.25, durationMs: 100 },
            ]) {
                expect(relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer',
                    message: { kind: 'sideband_control', control } })).toEqual({ ok: true });
            }
            await vi.waitFor(() => expect(automation.getTimeline(view).entries.map(entry => entry.status))
                .toEqual(['succeeded', 'succeeded', 'succeeded']));
            expect(commands).toEqual(expect.arrayContaining([
                expect.objectContaining({ method: 'Input.insertText', params: { text: 'hello' } }),
                expect.objectContaining({ method: 'Input.dispatchMouseEvent', params: {
                    type: 'mouseWheel', x: 200, y: 150, deltaX: 0, deltaY: 100,
                } }),
            ]));
            expect(relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer', message: {
                kind: 'sideband_control', control: { v: 1, streamId: 'stream', sourceId: 'another-view', eventId: 'wrong', kind: 'keyboard_text', text: 'secret' },
            } })).toEqual({ ok: false, reasonCode: 'input_lease_mismatch' });
            failInput = true;
            expect(relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer', message: {
                kind: 'sideband_control', control: { v: 1, streamId: 'stream', sourceId, eventId: 'failed-input', kind: 'keyboard_text', text: 'hello' },
            } })).toEqual({ ok: true });
            await vi.waitFor(() => expect(envelopes).toEqual(expect.arrayContaining([
                expect.objectContaining({ message: expect.objectContaining({ kind: 'receipt', receipt: expect.objectContaining({ terminal: false }) }) }),
            ])));
            for (const listener of [...listeners]) listener({ method: 'Page.screencastFrame', sessionId: 'cdp-page',
                params: { sessionId: 2, data: 'BAUG', metadata: { deviceWidth: 400, deviceHeight: 200 } } });
            expect(envelopes).toEqual(expect.arrayContaining([
                expect.objectContaining({ message: expect.objectContaining({ kind: 'frame', frame: expect.objectContaining({ payloadBase64: 'BAUG' }) }) }),
            ]));
            const observationStart = { ...start, streamId: 'observation', authorization: { ...start.authorization,
                payload: { ...start.authorization.payload, streamId: 'observation' } } };
            expect(await relay.start(observationStart)).toEqual({ ok: true, streamId: 'observation' });
            // Agent/recording observation must wait for a fresh frame, never inherit a retained
            // human picture which may have been captured during a confidential hold.
            expect(envelopes.filter(envelope => envelope.message.kind === 'frame'
                && envelope.message.frame.streamId === 'observation' && envelope.message.frame.payloadKind !== 'metadata')).toEqual([]);
            for (const listener of [...listeners]) listener({ method: 'Page.screencastFrame', sessionId: 'cdp-page',
                params: { sessionId: 3, data: 'BwgJ', metadata: { deviceWidth: 400, deviceHeight: 200 } } });
            const metadataFor = (streamId: string) => envelopes.filter(envelope => envelope.message.kind === 'frame'
                && envelope.message.frame.streamId === streamId && envelope.message.frame.payloadKind === 'metadata');
            const imagesFor = (streamId: string) => envelopes.filter(envelope => envelope.message.kind === 'frame'
                && envelope.message.frame.streamId === streamId && envelope.message.frame.payloadKind !== 'metadata');
            expect(metadataFor('observation').length).toBeGreaterThan(0);
            expect(imagesFor('observation').length).toBeGreaterThan(0);
            await automation.getInputControl(view).beginConfidentialityHold();
            const heldObservationCount = metadataFor('observation').length;
            const heldImageCount = imagesFor('observation').length;
            for (const listener of [...listeners]) listener({ method: 'Page.frameNavigated', sessionId: 'cdp-page',
                params: { frame: { id: 'main', loaderId: 'private-document', url: 'https://example.test/private-credential' } } });
            automation.getInputControl(view).handBack();
            expect(relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer', message: {
                kind: 'control', control: { v: 1, streamId: 'observation', kind: 'keyframe_required', reasonCode: 'viewer_request' },
            } })).toEqual({ ok: true });
            expect(metadataFor('observation')).toHaveLength(heldObservationCount);
            expect(imagesFor('observation')).toHaveLength(heldImageCount);
            expect(browserEvents()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'navigationStateChanged',
                currentUrl: 'https://example.test/private-credential' })]));
            await adapter.dispatchCommand({ kind: 'closeView', commandId: 'close', ...view });
            expect(browserEvents()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'viewClosed', ...view })]));
            expect(registry.resolve({ sourceId }).ok).toBe(false);
            await relay.stop('stream');
        } finally {
            await relay.dispose(); registration.dispose(); await producer.dispose(); automation.dispose(); adapter.dispose();
        }
    });
});
