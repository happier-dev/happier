import { describe, expect, it } from 'vitest';

describe('machine live-stream UI control gating', () => {
    it('blocks exclusive input without an active lease', async () => {
        const mod = await import('./control').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('canSendMachineLiveStreamControl');
        if (!('canSendMachineLiveStreamControl' in mod)) return;

        expect(mod.canSendMachineLiveStreamControl({
            source: { sourceId: 'source_1', inputMode: 'exclusive' },
            activeLease: null,
            nowMs: 1_000,
            control: {
                v: 1,
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'event_1',
                kind: 'tap',
                x: 0.5,
                y: 0.5,
            },
        })).toEqual({
            ok: false,
            reasonCode: 'input_lease_required',
        });
    });

    it('blocks exclusive input controls that omit the active lease id', async () => {
        const mod = await import('./control').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('canSendMachineLiveStreamControl');
        if (!('canSendMachineLiveStreamControl' in mod)) return;

        expect(mod.canSendMachineLiveStreamControl({
            source: { sourceId: 'source_1', inputMode: 'exclusive' },
            activeLease: {
                v: 1,
                leaseId: 'lease_1',
                streamId: 'stream_1',
                sourceId: 'source_1',
                holderId: 'viewer_1',
                mode: 'exclusive',
                acquiredAtMs: 1_000,
                expiresAtMs: 2_000,
            },
            nowMs: 1_100,
            control: {
                v: 1,
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'event_1',
                kind: 'tap',
                x: 0.5,
                y: 0.5,
            },
        })).toEqual({
            ok: false,
            reasonCode: 'input_lease_mismatch',
        });
    });

});
