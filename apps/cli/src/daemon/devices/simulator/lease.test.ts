import { describe, expect, it } from 'vitest';

describe('simulator input lease manager', () => {
    it('allows one active controller and expires stale leases', async () => {
        const mod = await import('./lease').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createSimulatorInputLeaseManager');
        if (!('createSimulatorInputLeaseManager' in mod)) return;

        const manager = mod.createSimulatorInputLeaseManager({ ttlMs: 1_000 });
        expect(manager.acquire({
            streamId: 'stream_1',
            sourceId: 'source_1',
            holderId: 'viewer_1',
            nowMs: 1_000,
        })).toMatchObject({ ok: true });
        expect(manager.acquire({
            streamId: 'stream_1',
            sourceId: 'source_1',
            holderId: 'viewer_2',
            nowMs: 1_500,
        })).toEqual({ ok: false, reasonCode: 'lease_already_held' });
        expect(manager.acquire({
            streamId: 'stream_1',
            sourceId: 'source_1',
            holderId: 'viewer_2',
            nowMs: 2_001,
        })).toMatchObject({ ok: true, lease: { holderId: 'viewer_2' } });
    });
});
