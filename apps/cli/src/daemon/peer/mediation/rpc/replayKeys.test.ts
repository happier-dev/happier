import { describe, expect, it } from 'vitest';

async function importReplayKeys() {
    return await import('./replayKeys').catch((error: unknown) => ({ importError: error }));
}

describe('direct machine RPC replay key cache', () => {
    it('claims each grant replay key once until the grant expires', async () => {
        const module = await importReplayKeys();
        expect(module).toHaveProperty('createPeerMachineRpcReplayKeyCache');
        if ('importError' in module) throw module.importError;

        let nowMs = 1_000;
        const cache = module.createPeerMachineRpcReplayKeyCache({ nowMs: () => nowMs });

        expect(cache.claim({
            grantId: 'grant_1',
            replayKey: 'request_1',
            expiresAtMs: 2_000,
        })).toBe(true);
        expect(cache.claim({
            grantId: 'grant_1',
            replayKey: 'request_1',
            expiresAtMs: 2_000,
        })).toBe(false);

        nowMs = 2_001;
        expect(cache.claim({
            grantId: 'grant_1',
            replayKey: 'request_1',
            expiresAtMs: 3_000,
        })).toBe(true);
    });
});
