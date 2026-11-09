import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { z } from 'zod/mini';
import {
    DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES} from '@happier-dev/protocol/features/payload/capabilities/deviceCapabilities';
import {
    DaemonMachineLiveStreamRelayStartRequestV1Schema,
    DaemonMachineLiveStreamRelayStartResponseV1Schema} from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import {
    MachineLiveStreamDecodedEnvelopeV1Schema,
    MachineLiveStreamRelayAuthorizationV1Schema,
    MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    type MachineLiveStreamRelayEnvelopeV1,
} from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import {
    MachineLiveStreamCodecIdV1Schema} from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';
import {
    SimulatorDeviceResourceV1Schema} from '@happier-dev/protocol/devices/simulator/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { DirectRouteGrantScopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { createMachineFixture, flushHookEffects, renderHook } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { ServerScopedMachineLiveStreamRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
const home = await network.addHome('https://simulator-stream.test', 'account-a');
await import('@/sync/domains/machines/peer/mediation/stream/productionRoute');
await import('@/sync/domains/machines/peer/mediation/stream/relayStartRpc');
afterAll(async () => { await network.dispose(); });
const STREAM_ID = 'stream_x';
const availableResource = SimulatorDeviceResourceV1Schema.parse({
    v: 1, simulatorId: 'sim_1', platform: 'ios', deviceId: 'device_1', displayName: 'iPhone 16',
    capture: { status: 'available', sourceId: 'source_1', supportedCodecs: ['image.mjpeg'], inputMode: 'exclusive' },
});
const grantRequests: Array<{ viewerSocketId: string; streamId: string }> = [];
const daemonStarts: Array<ReturnType<typeof DaemonMachineLiveStreamRelayStartRequestV1Schema.parse>> = [];
const features = () => {
    const base = createRootLayoutFeaturesResponse();
    return createRootLayoutFeaturesResponse({
        features: {
            devices: { enabled: true, simulatorPreview: { enabled: true } },
            browser: { enabled: true, viewTargets: { enabled: true } },
            machines: { enabled: true, liveStream: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: true } } },
        },
        capabilities: { machines: { ...base.capabilities.machines,
            liveStream: { serverRouted: { caps: {}, disabledReason: null } } }, devices: { simulatorPreview: {
            ...DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
            enabled: true, available: true, availableDevices: [availableResource],
        } } },
    });
};
beforeEach(async () => {
    network.resetRequests();
    await network.addHome(home.serverUrl, home.accountId);
    network.setHttpResponder(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/features') return Response.json(features());
        if (new URL(String(url)).pathname !== '/v1/machines/peer/mediation/route-grants') return null;
        const input = z.looseObject({
            machineId: z.string(), targetMachineId: z.string(), viewerSocketId: z.string(),
            maxFramesPerSecond: z.optional(z.number()), maxFrameBytes: z.optional(z.number()),
            codecId: z.optional(MachineLiveStreamCodecIdV1Schema),
            viewerCodecs: z.optional(z.array(MachineLiveStreamCodecIdV1Schema)),
            scope: DirectRouteGrantScopeV1Schema,
        }).parse(JSON.parse(String(init?.body)));
        if (input.scope.kind !== 'live_stream') throw new Error('Expected a live-stream grant');
        expect(input.machineId).toBe('daemon_1');
        expect(input.targetMachineId).toBe('daemon_1');
        grantRequests.push({ viewerSocketId: input.viewerSocketId, streamId: input.scope.streamId });
        const iat = Date.now();
        return new Response(JSON.stringify({ ok: true, relayAuthorization: MachineLiveStreamRelayAuthorizationV1Schema.parse({
            payload: { v: 1, grantId: 'relay_grant_stream_x', accountId: 'account-a',
                sourceMachineId: input.machineId, targetMachineId: input.targetMachineId,
                viewerSocketId: input.viewerSocketId, flowKind: 'live_stream', routeKind: 'server_relay',
                streamId: input.scope.streamId, streamFamily: input.scope.streamFamily,
                ...(input.scope.sourceId ? { sourceId: input.scope.sourceId } : {}),
                maxBitrateBps: input.scope.maxBitrateBps, maxFramesPerSecond: input.maxFramesPerSecond,
                maxFrameBytes: input.maxFrameBytes, maxDurationMs: input.scope.maxDurationMs,
                ...(input.codecId ? { codecId: input.codecId } : {}),
                ...(input.viewerCodecs ? { viewerCodecs: input.viewerCodecs } : {}),
                ...(input.scope.maxTotalBytes === undefined ? {} : { maxTotalBytes: input.scope.maxTotalBytes }),
                iat, exp: iat + DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedLiveStream, aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1 },
            signature: { keyId: 'relay_key_1', alg: 'Ed25519', valueBase64Url: 'AbCdEf012_-' },
        }) }));
    });
    network.setRpcResponder(async request => {
        if (request.method !== RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START) throw new Error(`Unexpected relay RPC: ${request.method}`);
        const input = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(request.payload);
        daemonStarts.push(input);
        return DaemonMachineLiveStreamRelayStartResponseV1Schema.parse({
            protocolVersion: 1, result: { ok: true, streamId: input.startRequest.streamId },
        });
    });
    grantRequests.length = 0; daemonStarts.length = 0;
    storage.getState().applySettingsLocal({ experiments: true });
    storage.getState().applyMachines([createMachineFixture({ id: 'daemon_1', storageMode: 'plain', activeAt: Date.now() })]);
});
function imageFrameEnvelope(streamId: string, sequence = 1): MachineLiveStreamRelayEnvelopeV1 {
    return MachineLiveStreamDecodedEnvelopeV1Schema.parse({
        v: 1, sourceMachineId: 'daemon_1', targetMachineId: 'daemon_1', viewerSocketId: 'viewer-socket-1',
        message: { kind: 'frame', frame: { v: 1, streamId, sequence, timestampMs: 1_000 + sequence,
            payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3 } },
    });
}
function createSocket(socketId = 'viewer-socket-1') {
    const sent: MachineLiveStreamRelayEnvelopeV1[] = [];
    const listeners = new Set<(envelope: MachineLiveStreamRelayEnvelopeV1) => void>();
    const socket: ServerScopedMachineLiveStreamRelaySocket = {
        scopeUserId: 'account-a', machineId: 'daemon_1', viewerId: 'viewer_1', socketId,
        onSocketIdChange: () => () => {},
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
        runtime: { serverId: home.id, viewerId: 'viewer_1', selectedSimulatorId: 'sim_1', resources, nowMs },
        ...(socket ? { relay: { socket, createStreamId } } : {}),
    }), { flushOptions: { cycles: 30 } });
}
describe('useSimulatorPreviewLiveSurface', () => {
    it('ingests MJPEG frames and retains the same relay authorization across rerenders and subsequent frames', async () => {
        const fake = createSocket();
        const hook = await mount(fake.socket);
        expect(hook.getCurrent().selectedSimulatorId).toBe('sim_1');
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(daemonStarts, JSON.stringify({ player: hook.getCurrent().viewModel?.stream,
                grants: grantRequests, rpc: network.requests.map(request => request.method) })).toHaveLength(1);
        });
        const streamId = daemonStarts[0].startRequest.streamId;
        expect(grantRequests).toEqual([{ viewerSocketId: 'viewer-socket-1', streamId }]);
        expect(daemonStarts[0].startRequest.viewerSocketId).toBe('viewer-socket-1');
        expect(fake.listenerCount()).toBe(1);
        await act(async () => fake.deliver(imageFrameEnvelope(streamId)));
        expect(hook.getCurrent().viewModel?.stream).toMatchObject({ phase: 'playing', lastFrameUrl: 'data:image/jpeg;base64,AQID' });
        await hook.rerender();
        await act(async () => fake.deliver(imageFrameEnvelope(streamId, 2)));
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
