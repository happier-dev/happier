import { describe, expect, it } from 'vitest';

describe('dispatchMachineLiveStreamControl', () => {
    it('denies exclusive input control without an active lease before invoking the adapter', async () => {
        const mod = await import('./control').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('dispatchMachineLiveStreamControl');
        if (!('dispatchMachineLiveStreamControl' in mod)) return;

        let invoked = false;

        await expect(mod.dispatchMachineLiveStreamControl({
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
            handleControl: async () => {
                invoked = true;
                return { ok: true };
            },
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'input_lease_required',
        });
        expect(invoked).toBe(false);
    });

    it('denies exclusive input control that omits the active lease id', async () => {
        const mod = await import('./control').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('dispatchMachineLiveStreamControl');
        if (!('dispatchMachineLiveStreamControl' in mod)) return;

        let invoked = false;

        await expect(mod.dispatchMachineLiveStreamControl({
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
            handleControl: async () => {
                invoked = true;
                return { ok: true };
            },
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'input_lease_mismatch',
        });
        expect(invoked).toBe(false);
    });
});
