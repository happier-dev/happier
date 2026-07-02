import { describe, expect, it } from 'vitest';

import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol';

function frame(sequence: number): MachineLiveStreamFrameV1 {
    return {
        v: 1,
        streamId: 'stream_1',
        sequence,
        timestampMs: 1_000 + sequence,
        payloadKind: 'image_keyframe',
        payloadEncoding: 'binary_base64',
        payloadBase64: 'AQID',
        payloadSizeBytes: 3,
    };
}

describe('simulator preview store reducer', () => {
    it('keeps last-known-good frame during reconnect', async () => {
        const mod = await import('./store').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceSimulatorPreviewState');
        if (!('reduceSimulatorPreviewState' in mod)) return;

        const connected = mod.reduceSimulatorPreviewState(
            { phase: 'idle', lastFrame: null },
            { type: 'frame', frame: frame(1) },
        );
        expect(mod.reduceSimulatorPreviewState(connected, { type: 'reconnecting' })).toMatchObject({
            phase: 'reconnecting',
            lastFrame: { sequence: 1 },
        });
    });

    it('tracks the active input lease and typed sidebands without clearing the last frame', async () => {
        const mod = await import('./store').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceSimulatorPreviewState');
        if (!('reduceSimulatorPreviewState' in mod)) return;

        const withFrame = mod.reduceSimulatorPreviewState(
            { phase: 'idle', lastFrame: null },
            { type: 'frame', frame: frame(1) },
        );
        const withLease = mod.reduceSimulatorPreviewState(withFrame, {
            type: 'lease_acquired',
            lease: {
                v: 1,
                leaseId: 'lease_1',
                streamId: 'stream_1',
                sourceId: 'source_1',
                holderId: 'viewer_1',
                mode: 'exclusive',
                acquiredAtMs: 1_000,
                expiresAtMs: 2_000,
            },
        });
        const withSideband = mod.reduceSimulatorPreviewState(withLease, {
            type: 'sideband',
            message: {
                v: 1,
                simulatorId: 'sim_1',
                emittedAtMs: 1_100,
                kind: 'capture_health',
                status: 'degraded',
                reasonCode: 'slow_consumer',
            },
        });

        expect(withSideband).toMatchObject({
            lastFrame: { sequence: 1 },
            activeLease: { leaseId: 'lease_1' },
            sidebandsByKind: {
                capture_health: { status: 'degraded', reasonCode: 'slow_consumer' },
            },
        });

        expect(mod.reduceSimulatorPreviewState(withSideband, { type: 'lease_released', leaseId: 'lease_1' })).toMatchObject({
            lastFrame: { sequence: 1 },
            activeLease: null,
        });
    });
});
