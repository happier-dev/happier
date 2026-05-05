import { describe, expect, it } from 'vitest';

async function importCallLimits() {
    return await import('./callLimits').catch((error: unknown) => ({ importError: error }));
}

describe('direct machine RPC call limits', () => {
    it('caps concurrent calls per grant scope at the smaller scope and local peer limits', async () => {
        const module = await importCallLimits();
        expect(module).toHaveProperty('createPeerMachineRpcCallLimiter');
        if ('importError' in module) throw module.importError;

        const limiter = module.createPeerMachineRpcCallLimiter({
            nowMs: () => 2_000,
            localPerPeerMaxConcurrentCalls: 8,
        });
        const key = {
            accountId: 'account_1',
            machineId: 'machine_1',
            endpointFingerprint: 'endpoint_1',
            grantId: 'grant_1',
        };
        const first = limiter.tryAcquire({
            key,
            scope: { maxCalls: 1, maxIdleMs: 10_000 },
        });
        const second = limiter.tryAcquire({
            key,
            scope: { maxCalls: 1, maxIdleMs: 10_000 },
        });

        expect(first.ok).toBe(true);
        expect(second).toEqual({ ok: false, reasonCode: 'direct_call_limit_exceeded' });
        if (first.ok) first.release();
        expect(limiter.tryAcquire({
            key,
            scope: { maxCalls: 1, maxIdleMs: 10_000 },
        }).ok).toBe(true);
    });
});
