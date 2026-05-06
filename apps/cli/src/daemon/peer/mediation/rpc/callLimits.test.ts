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

    it('returns a dedicated idle-expired reason and evicts stale grant activity', async () => {
        const module = await importCallLimits();
        expect(module).toHaveProperty('createPeerMachineRpcCallLimiter');
        if ('importError' in module) throw module.importError;

        let nowMs = 1_000;
        const limiter = module.createPeerMachineRpcCallLimiter({
            nowMs: () => nowMs,
            localPerPeerMaxConcurrentCalls: 8,
        });
        const staleKey = {
            accountId: 'account_1',
            machineId: 'machine_1',
            endpointFingerprint: 'endpoint_1',
            grantId: 'grant_stale',
        };
        const currentKey = {
            ...staleKey,
            grantId: 'grant_current',
        };

        const stale = limiter.tryAcquire({
            key: staleKey,
            scope: { maxCalls: 1, maxIdleMs: 100 },
        });
        expect(stale.ok).toBe(true);
        if (stale.ok) stale.release();

        nowMs = 1_101;
        expect(limiter.tryAcquire({
            key: staleKey,
            scope: { maxCalls: 1, maxIdleMs: 100 },
        })).toEqual({ ok: false, reasonCode: 'grant_idle_expired' });

        nowMs = 1_500;
        expect(limiter.tryAcquire({
            key: currentKey,
            scope: { maxCalls: 1, maxIdleMs: 100 },
        }).ok).toBe(true);
        expect(limiter.tryAcquire({
            key: staleKey,
            scope: { maxCalls: 1, maxIdleMs: 100 },
        }).ok).toBe(true);
    });
});
