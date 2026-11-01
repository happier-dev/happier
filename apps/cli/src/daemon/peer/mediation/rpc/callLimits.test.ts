import { describe, expect, it } from 'vitest';

import { createPeerMachineRpcCallLimiter } from './callLimits';

describe('direct machine RPC call limits', () => {
    it.each([
        { localLimit: 8, scopeLimit: 1 },
        { localLimit: 1, scopeLimit: 8 },
    ])('uses the smaller concurrent limit (local=$localLimit, scope=$scopeLimit)', ({ localLimit, scopeLimit }) => {
        const limiter = createPeerMachineRpcCallLimiter({
            nowMs: () => 2_000,
            localPerPeerMaxConcurrentCalls: localLimit,
        });
        const key = {
            accountId: 'account_1',
            machineId: 'machine_1',
            endpointFingerprint: 'endpoint_1',
            grantId: 'grant_1',
        };
        const first = limiter.tryAcquire({
            key,
            scope: { maxCalls: scopeLimit, maxIdleMs: 10_000 },
        });
        const second = limiter.tryAcquire({
            key,
            scope: { maxCalls: scopeLimit, maxIdleMs: 10_000 },
        });

        expect(first.ok).toBe(true);
        expect(second).toEqual({ ok: false, reasonCode: 'direct_call_limit_exceeded' });
        if (first.ok) first.release();
        expect(limiter.tryAcquire({
            key,
            scope: { maxCalls: scopeLimit, maxIdleMs: 10_000 },
        }).ok).toBe(true);
    });

    it('returns a dedicated idle-expired reason and evicts stale grant activity', () => {
        let nowMs = 1_000;
        const limiter = createPeerMachineRpcCallLimiter({
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
