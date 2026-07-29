import { describe, expect, it } from 'vitest';
import type { SimulatorDeviceResourceV1 } from '@happier-dev/protocol';

import {
    DEFAULT_SIMULATOR_LIVE_STREAM_CAPS,
    createSimulatorLiveStreamIdentityResolver,
    createDefaultSimulatorLiveStreamId,
    resolveSimulatorLiveStreamIdentity,
} from './liveStreamIdentity';

function availableResource(): SimulatorDeviceResourceV1 {
    return {
        v: 1,
        simulatorId: 'sim_1',
        platform: 'ios',
        deviceId: 'device_1',
        displayName: 'iPhone 16',
        capture: {
            status: 'available',
            sourceId: 'source_1',
            supportedCodecs: ['image.mjpeg', 'h264.avcc'],
            inputMode: 'exclusive',
        },
    };
}

function unavailableResource(): SimulatorDeviceResourceV1 {
    return {
        v: 1,
        simulatorId: 'sim_2',
        platform: 'android',
        deviceId: 'device_2',
        displayName: 'Pixel',
        capture: { status: 'unavailable', reasonCode: 'capture_unsupported' },
    };
}

describe('resolveSimulatorLiveStreamIdentity', () => {
    it('derives the canonical identity from the selected capture-available resource', () => {
        const identity = resolveSimulatorLiveStreamIdentity({
            resources: [availableResource()],
            selectedSimulatorId: 'sim_1',
            sourceMachineId: 'daemon_1',
            // The relay target machine is the capture daemon; the watcher is a per-tab viewer
            // identified by viewerId + viewerSocketId (NOT a machine id).
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
            viewerSocketId: 'viewer-socket-1',
        });

        expect(identity).toEqual({
            simulatorId: 'sim_1',
            sourceMachineId: 'daemon_1',
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
            viewerSocketId: 'viewer-socket-1',
            streamId: 'sim-live:daemon_1:source_1:viewer-socket-1',
            streamFamily: 'source_1',
            sourceCodecs: ['image.mjpeg', 'h264.avcc'],
            caps: DEFAULT_SIMULATOR_LIVE_STREAM_CAPS,
        });
    });

    it('returns null when there is no selection or no resolved relay/viewer identity', () => {
        expect(resolveSimulatorLiveStreamIdentity({
            resources: [availableResource()],
            selectedSimulatorId: null,
            sourceMachineId: 'daemon_1',
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
            viewerSocketId: 'viewer-socket-1',
        })).toBeNull();
        expect(resolveSimulatorLiveStreamIdentity({
            resources: [availableResource()],
            selectedSimulatorId: 'sim_1',
            sourceMachineId: '',
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
            viewerSocketId: 'viewer-socket-1',
        })).toBeNull();
        expect(resolveSimulatorLiveStreamIdentity({
            resources: [availableResource()],
            selectedSimulatorId: 'sim_1',
            sourceMachineId: 'daemon_1',
            targetMachineId: '   ',
            viewerId: 'user_1',
            viewerSocketId: 'viewer-socket-1',
        })).toBeNull();
        // Fail-closed when the viewer identity is missing (cannot target a tab).
        expect(resolveSimulatorLiveStreamIdentity({
            resources: [availableResource()],
            selectedSimulatorId: 'sim_1',
            sourceMachineId: 'daemon_1',
            targetMachineId: 'daemon_1',
            viewerId: '   ',
            viewerSocketId: 'viewer-socket-1',
        })).toBeNull();
        // Fail closed when the per-tab socket id is missing: falling back to a viewer/user id
        // produces a valid-looking stream id but the server relay cannot target the tab.
        expect(resolveSimulatorLiveStreamIdentity({
            resources: [availableResource()],
            selectedSimulatorId: 'sim_1',
            sourceMachineId: 'daemon_1',
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
            viewerSocketId: '   ',
        })).toBeNull();
    });

    it('fails closed when the selected resource is not capture-available', () => {
        expect(resolveSimulatorLiveStreamIdentity({
            resources: [unavailableResource()],
            selectedSimulatorId: 'sim_2',
            sourceMachineId: 'daemon_1',
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
            viewerSocketId: 'viewer-socket-1',
        })).toBeNull();
    });

    it('honors injected caps and stream-id factory', () => {
        const identity = resolveSimulatorLiveStreamIdentity({
            resources: [availableResource()],
            selectedSimulatorId: 'sim_1',
            sourceMachineId: 'daemon_1',
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
            viewerSocketId: 'viewer-socket-1',
            caps: { maxBitrateBps: 1_000, maxFramesPerSecond: 5, maxFrameBytes: 500, maxDurationMs: 1_000 },
            createStreamId: ({ streamFamily }) => `custom:${streamFamily}`,
        });

        expect(identity?.streamId).toBe('custom:source_1');
        expect(identity?.caps.maxFramesPerSecond).toBe(5);
    });

    it('keys the default stream id per viewer socket so two tabs of one user stay isolated', () => {
        const tabA = createDefaultSimulatorLiveStreamId({
            sourceMachineId: 'daemon_1',
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
            viewerSocketId: 'viewer-socket-a',
            streamFamily: 'source_1',
        });
        const tabB = createDefaultSimulatorLiveStreamId({
            sourceMachineId: 'daemon_1',
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
            viewerSocketId: 'viewer-socket-b',
            streamFamily: 'source_1',
        });

        expect(tabA).toBe('sim-live:daemon_1:source_1:viewer-socket-a');
        expect(tabB).toBe('sim-live:daemon_1:source_1:viewer-socket-b');
        expect(tabA).not.toBe(tabB);

        // The low-level id factory still stays deterministic for legacy machine-to-machine callers.
        // The product identity resolver above fails closed before using this fallback.
        expect(createDefaultSimulatorLiveStreamId({
            sourceMachineId: 'daemon_1',
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
            viewerSocketId: '',
            streamFamily: 'source_1',
        })).toBe('sim-live:daemon_1:source_1:user_1');
    });

    it('keeps referential stability per resolver instance instead of one module-global slot', () => {
        const resolverA = createSimulatorLiveStreamIdentityResolver();
        const resolverB = createSimulatorLiveStreamIdentityResolver();
        const base = {
            resources: [availableResource()],
            selectedSimulatorId: 'sim_1',
            sourceMachineId: 'daemon_1',
            targetMachineId: 'daemon_1',
            viewerId: 'user_1',
        };

        const tabA1 = resolverA({ ...base, viewerSocketId: 'viewer-socket-a' });
        const tabB1 = resolverB({ ...base, viewerSocketId: 'viewer-socket-b' });
        const tabA2 = resolverA({ ...base, viewerSocketId: 'viewer-socket-a' });

        expect(tabA1).not.toBeNull();
        expect(tabB1).not.toBeNull();
        expect(tabA2).toBe(tabA1);
        expect(tabB1).not.toBe(tabA1);
        expect(tabB1?.streamId).toBe('sim-live:daemon_1:source_1:viewer-socket-b');
    });
});
