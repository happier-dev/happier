import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamRelayEnvelopeV1,
    type SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { ServerScopedMachineLiveStreamRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket';

const testState = vi.hoisted(() => ({
    useFeatureDetails: vi.fn(),
    useFeatureDecision: vi.fn(),
    openRelayClient: vi.fn(async (..._args: readonly unknown[]) => ({ ok: true as const, streamId: 'stream_x' })),
}));

vi.mock('@/hooks/server/useFeatureDetails', () => ({
    useFeatureDetails: (...args: readonly unknown[]) => testState.useFeatureDetails(...args),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (...args: readonly unknown[]) => testState.useFeatureDecision(...args),
}));

vi.mock('@/sync/domains/machines/peer/mediation/stream', async (importActual) => {
    const actual = await importActual<typeof import('@/sync/domains/machines/peer/mediation/stream')>();
    return {
        ...actual,
        // The production transport itself is exercised in relayClient/serverScoped tests;
        // here we mock only the server round-trip so the focus is the composition's
        // socket -> ingestion -> runtime view-model frame flow.
        openMachineLiveStreamRelayClient: (...args: readonly unknown[]) => testState.openRelayClient(...args),
    };
});

const STREAM_ID = 'stream_x';

const availableResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'sim_1',
    platform: 'ios',
    deviceId: 'device_1',
    displayName: 'iPhone 16',
    capture: {
        status: 'available',
        sourceId: 'source_1',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
    },
};

function simulatorPreviewDecision(state: 'enabled' | 'disabled') {
    return {
        featureId: 'devices.simulatorPreview',
        state,
        blockedBy: state === 'enabled' ? null : 'server',
        blockerCode: state === 'enabled' ? 'none' : 'feature_disabled',
        diagnostics: [],
        evaluatedAt: 1_000,
        scope: { scopeKind: 'runtime' },
    };
}

function enableFeature(): void {
    testState.useFeatureDecision.mockReturnValue(simulatorPreviewDecision('enabled'));
    testState.useFeatureDetails.mockReturnValue({
        enabled: true,
        available: true,
        supportedPlatforms: ['ios'],
        availableDevices: [availableResource],
        captureSupported: true,
        inputSupported: true,
        sidebandKinds: [],
        disabledReasons: [],
    });
}

function imageFrameEnvelope(): MachineLiveStreamRelayEnvelopeV1 {
    const frame: MachineLiveStreamFrameV1 = {
        v: 1,
        streamId: STREAM_ID,
        sequence: 1,
        timestampMs: 1_001,
        payloadKind: 'image_keyframe',
        payloadEncoding: 'binary_base64',
        payloadBase64: 'AQID',
        payloadSizeBytes: 3,
    };
    // The relay target machine is the capture daemon itself; the per-tab viewer rides
    // `viewerSocketId`, never `scopeUserId` masquerading as a machine id (C4).
    return {
        v: 1,
        sourceMachineId: 'daemon_1',
        targetMachineId: 'daemon_1',
        viewerSocketId: 'viewer-socket-1',
        message: { kind: 'frame', frame },
    };
}

function createFakeSocket(socketId = 'viewer-socket-1'): {
    socket: ServerScopedMachineLiveStreamRelaySocket;
    sent: MachineLiveStreamRelayEnvelopeV1[];
    deliver: (envelope: unknown) => void;
    listenerCount: () => number;
} {
    const sent: MachineLiveStreamRelayEnvelopeV1[] = [];
    const listeners = new Set<(envelope: MachineLiveStreamRelayEnvelopeV1) => void>();
    return {
        sent,
        deliver: (envelope) => {
            for (const listener of [...listeners]) listener(envelope as MachineLiveStreamRelayEnvelopeV1);
        },
        listenerCount: () => listeners.size,
        socket: {
            scopeUserId: 'user_1',
            machineId: 'daemon_1',
            viewerId: 'user_1',
            socketId,
            sendEnvelope: (payload) => {
                sent.push(payload);
            },
            onEnvelope: (listener) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            disconnect: () => {},
        },
    };
}

describe('useSimulatorPreviewLiveSurface', () => {
    afterEach(() => {
        testState.useFeatureDetails.mockReset();
        testState.useFeatureDecision.mockReset();
        testState.openRelayClient.mockClear();
        standardCleanup();
    });

    it('routes relay frames through ingestion into the runtime view-model decoders', async () => {
        enableFeature();
        const fake = createFakeSocket();
        const mod = await import('./useSimulatorPreviewLiveSurface');

        const hook = await renderHook(() => mod.useSimulatorPreviewLiveSurface({
            runtime: {
                serverId: 'server_1',
                viewerId: 'viewer_1',
                selectedSimulatorId: 'sim_1',
                nowMs: () => 1_000,
            },
            relay: {
                socket: fake.socket,
                createStreamId: () => STREAM_ID,
            },
        }));

        expect(hook.getCurrent().selectedSimulatorId).toBe('sim_1');
        expect(fake.listenerCount()).toBe(1);

        await act(async () => {
            fake.deliver(imageFrameEnvelope());
        });

        const stream = hook.getCurrent().viewModel?.stream;
        expect(stream?.phase).toBe('playing');
        expect(stream?.lastFrameUrl).toBe('data:image/jpeg;base64,AQID');
    });

    it('opens the relay client exactly once and renders bounded across frames (L0-5 regression)', async () => {
        // Regression for the render->setState feedback loop ("Maximum update depth exceeded").
        // The pre-fix `feedbackPlayerStates` mirror re-subscribed the relay client on every
        // render and never settled; this asserts the relay opens once and each new frame causes
        // a bounded number of additional renders (not an unbounded cascade).
        enableFeature();
        const fake = createFakeSocket();
        const mod = await import('./useSimulatorPreviewLiveSurface');

        let renderCount = 0;
        const hook = await renderHook(() => {
            renderCount += 1;
            return mod.useSimulatorPreviewLiveSurface({
                runtime: {
                    serverId: 'server_1',
                    viewerId: 'viewer_1',
                    selectedSimulatorId: 'sim_1',
                    nowMs: () => 1_000,
                },
                relay: {
                    socket: fake.socket,
                    createStreamId: () => STREAM_ID,
                },
            });
        });

        // The relay client subscribes once and stays subscribed; the open-effect must not
        // re-fire per render.
        expect(fake.listenerCount()).toBe(1);
        expect(testState.openRelayClient).toHaveBeenCalledTimes(1);
        // A finite, small render count after mount + effects settle — never an unbounded loop.
        const rendersAfterMount = renderCount;
        expect(rendersAfterMount).toBeLessThanOrEqual(8);

        await act(async () => {
            fake.deliver(imageFrameEnvelope());
        });

        // A single new frame produces a bounded number of additional renders and never re-opens
        // the relay client.
        expect(renderCount - rendersAfterMount).toBeLessThanOrEqual(4);
        expect(testState.openRelayClient).toHaveBeenCalledTimes(1);
        expect(fake.listenerCount()).toBe(1);
        expect(hook.getCurrent().viewModel?.stream.phase).toBe('playing');
    });

    it('does not subscribe to the relay when no socket is provided (additive)', async () => {
        enableFeature();
        const mod = await import('./useSimulatorPreviewLiveSurface');

        const hook = await renderHook(() => mod.useSimulatorPreviewLiveSurface({
            runtime: {
                serverId: 'server_1',
                viewerId: 'viewer_1',
                selectedSimulatorId: 'sim_1',
                nowMs: () => 1_000,
            },
        }));

        expect(hook.getCurrent().selectedSimulatorId).toBe('sim_1');
        expect(hook.getCurrent().viewModel?.stream.lastFrameUrl).toBeUndefined();
    });

    it('fails closed visibly when the viewer socket id is empty', async () => {
        enableFeature();
        const fake = createFakeSocket('');
        const mod = await import('./useSimulatorPreviewLiveSurface');

        const hook = await renderHook(() => mod.useSimulatorPreviewLiveSurface({
            runtime: {
                serverId: 'server_1',
                viewerId: 'viewer_1',
                selectedSimulatorId: 'sim_1',
                nowMs: () => 1_000,
            },
            relay: {
                socket: fake.socket,
                createStreamId: () => STREAM_ID,
            },
        }));

        expect(fake.listenerCount()).toBe(0);
        expect(testState.openRelayClient).not.toHaveBeenCalled();
        expect(hook.getCurrent().viewModel?.stream.phase).toBe('error');
        expect(hook.getCurrent().viewModel?.stream.diagnostic?.reasonCode).toBe('viewer_unreachable');
        expect(hook.getCurrent().viewModel?.availability).toEqual({
            state: 'unavailable',
            reasonCode: 'viewer_unreachable',
        });
        expect(hook.getCurrent().viewModel?.controls.canWatch).toBe(false);
    });
});
