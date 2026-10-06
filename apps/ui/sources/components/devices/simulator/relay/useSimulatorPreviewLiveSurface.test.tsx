import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { z } from 'zod';
import {
    DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
    DaemonMachineLiveStreamRelayStartRequestV1Schema,
    DaemonMachineLiveStreamRelayStartResponseV1Schema,
    MachineLiveStreamDecodedEnvelopeV1Schema,
    MachineLiveStreamCodecIdV1Schema,
    MachineLiveStreamRelayAuthorizationV1Schema,
    MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    SimulatorDeviceResourceV1Schema,
    type MachineLiveStreamRelayEnvelopeV1,
} from '@happier-dev/protocol';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createMachineFixture, flushHookEffects, renderHook } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { ServerScopedMachineLiveStreamRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket';
import { installSessionDetailsPanelCommonModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
const STREAM_ID = 'stream_x';
const availableResource = SimulatorDeviceResourceV1Schema.parse({
    v: 1, simulatorId: 'sim_1', platform: 'ios', deviceId: 'device_1', displayName: 'iPhone 16',
    capture: { status: 'available', sourceId: 'source_1', supportedCodecs: ['image.mjpeg'], inputMode: 'exclusive' },
});
const grantRequests: Array<{ viewerSocketId: string; streamId: string }> = [];
const daemonStarts: Array<ReturnType<typeof DaemonMachineLiveStreamRelayStartRequestV1Schema.parse>> = [];
const runtime = installSessionPaneRuntimeTestHarness({
    features: () => createRootLayoutFeaturesResponse({
        features: {
            devices: { simulatorPreview: { enabled: true } },
            machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } },
        },
        capabilities: { devices: { simulatorPreview: {
            ...DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
            enabled: true, available: true, availableDevices: [availableResource],
        } } },
    }),
    request: async (url, init) => {
        if (new URL(String(url)).pathname !== '/v1/machines/peer/mediation/route-grants') return null;
        const input = z.object({
            machineId: z.string(), targetMachineId: z.string(), viewerSocketId: z.string(),
            maxFramesPerSecond: z.number(), maxFrameBytes: z.number(),
            codecId: MachineLiveStreamCodecIdV1Schema.optional(),
            viewerCodecs: z.array(MachineLiveStreamCodecIdV1Schema).optional(),
            scope: z.object({ streamId: z.string(), streamFamily: z.string(), maxBitrateBps: z.number(),
                maxDurationMs: z.number(), maxTotalBytes: z.number().optional() }).passthrough(),
        }).passthrough().parse(JSON.parse(String(init?.body)));
        expect(input.machineId).toBe('daemon_1');
        expect(input.targetMachineId).toBe('daemon_1');
        grantRequests.push({ viewerSocketId: input.viewerSocketId, streamId: input.scope.streamId });
        const iat = Date.now();
        return new Response(JSON.stringify({ ok: true, relayAuthorization: MachineLiveStreamRelayAuthorizationV1Schema.parse({
            payload: { v: 1, grantId: 'relay_grant_stream_x', accountId: 'account-a',
                sourceMachineId: input.machineId, targetMachineId: input.targetMachineId,
                viewerSocketId: input.viewerSocketId, flowKind: 'live_stream', routeKind: 'server_relay',
                streamId: input.scope.streamId, streamFamily: input.scope.streamFamily,
                maxBitrateBps: input.scope.maxBitrateBps, maxFramesPerSecond: input.maxFramesPerSecond,
                maxFrameBytes: input.maxFrameBytes, maxDurationMs: input.scope.maxDurationMs,
                ...(input.codecId ? { codecId: input.codecId } : {}),
                ...(input.viewerCodecs ? { viewerCodecs: input.viewerCodecs } : {}),
                ...(input.scope.maxTotalBytes === undefined ? {} : { maxTotalBytes: input.scope.maxTotalBytes }),
                iat, exp: iat + input.scope.maxDurationMs, aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1 },
            signature: { keyId: 'relay_key_1', alg: 'Ed25519', valueBase64Url: 'AbCdEf012_-' },
        }) }));
    },
    configureSocket: socket => {
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true; socket.id = 'viewer-socket-1';
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.spyOn(socket, 'disconnect').mockImplementation(() => { socket.connected = false; return socket; });
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
            if (event !== 'rpc-call') throw new Error(`Unexpected relay transport event: ${event}`);
            const request = z.object({ method: z.string(), params: z.unknown() }).passthrough().parse(payload);
            if (request.method.endsWith(`:${RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START}`)) {
                const input = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(request.params);
                daemonStarts.push(input);
                return { ok: true, result: DaemonMachineLiveStreamRelayStartResponseV1Schema.parse({
                    protocolVersion: 1, result: { ok: true, streamId: input.startRequest.streamId },
                }) };
            }
            return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
    },
});
beforeEach(() => {
    grantRequests.length = 0; daemonStarts.length = 0;
    storage.getState().applySettingsLocal({ experiments: true });
    storage.getState().applyMachines([createMachineFixture({ id: 'daemon_1', activeAt: Date.now() })]);
});
function imageFrameEnvelope(sequence = 1): MachineLiveStreamRelayEnvelopeV1 {
    return MachineLiveStreamDecodedEnvelopeV1Schema.parse({
        v: 1, sourceMachineId: 'daemon_1', targetMachineId: 'daemon_1', viewerSocketId: 'viewer-socket-1',
        message: { kind: 'frame', frame: { v: 1, streamId: STREAM_ID, sequence, timestampMs: 1_000 + sequence,
            payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3 } },
    });
}
function createSocket(socketId = 'viewer-socket-1') {
    const sent: MachineLiveStreamRelayEnvelopeV1[] = [];
    const listeners = new Set<(envelope: MachineLiveStreamRelayEnvelopeV1) => void>();
    const socket: ServerScopedMachineLiveStreamRelaySocket = {
        scopeUserId: 'account-a', machineId: 'daemon_1', viewerId: 'viewer_1', socketId,
        sendEnvelope: envelope => { sent.push(envelope); },
        onEnvelope: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        disconnect: async () => {},
    };
    return { socket, sent, listenerCount: () => listeners.size,
        deliver: (envelope: unknown) => {
            const parsed = MachineLiveStreamDecodedEnvelopeV1Schema.parse(envelope);
            for (const listener of listeners) listener(parsed);
        } };
}
const nowMs = () => 1_000;
const createStreamId = () => STREAM_ID;
const resources = [availableResource];
async function mount(socket?: ServerScopedMachineLiveStreamRelaySocket) {
    const { useSimulatorPreviewLiveSurface } = await import('./useSimulatorPreviewLiveSurface');
    return renderHook(() => useSimulatorPreviewLiveSurface({
        runtime: { serverId: runtime.serverId, viewerId: 'viewer_1', selectedSimulatorId: 'sim_1', resources, nowMs },
        ...(socket ? { relay: { socket, createStreamId } } : {}),
    }), { wrapper: runtime.Wrapper, flushOptions: { cycles: 30 } });
}
describe('useSimulatorPreviewLiveSurface', () => {
    it('ingests MJPEG frames and retains the same relay authorization across rerenders and subsequent frames', async () => {
        const fake = createSocket();
        const hook = await mount(fake.socket);
        expect(hook.getCurrent().selectedSimulatorId).toBe('sim_1');
        expect(grantRequests).toEqual([{ viewerSocketId: 'viewer-socket-1', streamId: STREAM_ID }]);
        expect(daemonStarts).toHaveLength(1);
        expect(daemonStarts[0].startRequest.viewerSocketId).toBe('viewer-socket-1');
        expect(fake.listenerCount()).toBe(1);
        await act(async () => fake.deliver(imageFrameEnvelope()));
        expect(hook.getCurrent().viewModel?.stream).toMatchObject({ phase: 'playing', lastFrameUrl: 'data:image/jpeg;base64,AQID' });
        await hook.rerender();
        await act(async () => fake.deliver(imageFrameEnvelope(2)));
        await flushHookEffects();
        expect(hook.getCurrent().viewModel?.stream.phase).toBe('playing');
        expect(grantRequests).toHaveLength(1);
        expect(daemonStarts).toHaveLength(1);
        expect(fake.listenerCount()).toBe(1);
        await hook.unmount();
        expect(fake.listenerCount()).toBe(0);
        expect(fake.sent.some(envelope => envelope.message.kind === 'control' && envelope.message.control.kind === 'stop')).toBe(true);
    });
    it('keeps the runtime additive without a relay socket', async () => {
        const hook = await mount();
        expect(hook.getCurrent().selectedSimulatorId).toBe('sim_1');
        expect(hook.getCurrent().viewModel?.stream.lastFrameUrl).toBeUndefined();
        expect(grantRequests).toEqual([]);
        expect(daemonStarts).toEqual([]);
    });
    it('fails closed visibly before granting or subscribing when the viewer socket id is empty', async () => {
        const fake = createSocket('');
        const hook = await mount(fake.socket);
        expect(fake.listenerCount()).toBe(0);
        expect(grantRequests).toEqual([]);
        expect(daemonStarts).toEqual([]);
        expect(hook.getCurrent().viewModel?.stream).toMatchObject({ phase: 'error', diagnostic: { reasonCode: 'viewer_unreachable' } });
        expect(hook.getCurrent().viewModel?.availability).toEqual({ state: 'unavailable', reasonCode: 'viewer_unreachable' });
        expect(hook.getCurrent().viewModel?.controls.canWatch).toBe(false);
    });
});
