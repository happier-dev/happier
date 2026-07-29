import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol';
import type {
    BuiltInLegacyConnectedAccountOperation,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import type { connectedServiceQuotaRecoveryCreditConsume } from '@/sync/ops/connectedServiceQuotaRecoveryCredits';

const {
    getConnectedServiceQuotaSnapshotPlainSpy,
    getConnectedServiceQuotaSnapshotSealedSpy,
    requestConnectedServiceQuotaSnapshotRefreshSpy,
    requestConnectedServiceQuotaSnapshotRefreshV3Spy,
    connectedServiceQuotaRecoveryCreditConsumeSpy,
} = vi.hoisted(() => ({
    getConnectedServiceQuotaSnapshotPlainSpy: vi.fn(),
    getConnectedServiceQuotaSnapshotSealedSpy: vi.fn(),
    requestConnectedServiceQuotaSnapshotRefreshSpy: vi.fn(),
    requestConnectedServiceQuotaSnapshotRefreshV3Spy: vi.fn(),
    connectedServiceQuotaRecoveryCreditConsumeSpy: vi.fn<
        (...args: Parameters<typeof connectedServiceQuotaRecoveryCreditConsume>) =>
            ReturnType<typeof connectedServiceQuotaRecoveryCreditConsume>
    >(),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
    getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
    requestConnectedServiceQuotaSnapshotRefresh: requestConnectedServiceQuotaSnapshotRefreshSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
    requestConnectedServiceQuotaSnapshotRefreshV3: requestConnectedServiceQuotaSnapshotRefreshV3Spy,
}));

vi.mock('@/sync/domains/connectedServices/openConnectedServiceQuotaViewSnapshot', () => ({
    openConnectedServiceQuotaViewSnapshot: vi.fn(() => null),
}));

vi.mock('@/sync/ops/connectedServiceQuotaRecoveryCredits', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/connectedServiceQuotaRecoveryCredits')>();
    return {
        ...actual,
        connectedServiceQuotaRecoveryCreditConsume: connectedServiceQuotaRecoveryCreditConsumeSpy,
    };
});

function buildSnapshot(fetchedAt = 1_234): ConnectedServiceQuotaSnapshotV1 {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        recoveryCredits: {
            availableCount: 1,
            credits: [{ id: 'credit-1', kind: 'usage_limit_reset', status: 'available' }],
        },
        meters: [],
    });
}

async function flushAsyncTurns(turns = 5): Promise<void> {
    for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

describe('connectedServiceQuotaSnapshotStore', () => {
    beforeEach(async () => {
        const { __resetConnectedServiceQuotaSnapshotStore } = await import('./connectedServiceQuotaSnapshotStore');
        __resetConnectedServiceQuotaSnapshotStore();
        vi.clearAllMocks();
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(buildSnapshot());
        getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue(null);
        requestConnectedServiceQuotaSnapshotRefreshSpy.mockResolvedValue(true);
        requestConnectedServiceQuotaSnapshotRefreshV3Spy.mockResolvedValue(true);
        connectedServiceQuotaRecoveryCreditConsumeSpy.mockResolvedValue({
            ok: true,
            receipt: {
                idempotencyKey: 'receipt-key',
                providerCreditId: 'credit-1',
                status: 'consumed',
            },
            snapshot: buildSnapshot(1_235),
        });
    });

    it('consumes settings reset credits through the connected-service recovery-credit operation', async () => {
        const {
            buildQuotaSnapshotScopeKey,
            consumeQuotaRecoveryCredit,
            getQuotaSnapshotEntry,
            retainQuotaSnapshotPolling,
        } = await import('./connectedServiceQuotaSnapshotStore');
        const ctx = {
            credentials: { token: 't', secret: 's' },
            credentialScope: 'scope',
            serverBasis: {
                serverId: 'server-a',
                generation: 3,
            },
            serviceId: 'openai-codex',
            profileId: 'work',
            resolveAccountMode: async () => 'plain' as const,
            assertOperationAllowed: async () => {},
        } as const;
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await flushAsyncTurns();

        expect(getQuotaSnapshotEntry(key).snapshot?.fetchedAt).toBe(1_234);

        const result = await consumeQuotaRecoveryCredit(key, {
            ...ctx,
            machineId: 'machine-1',
            providerCreditId: 'credit-1',
        });

        release();
        expect(result).toEqual({
            ok: true,
            receipt: {
                idempotencyKey: 'receipt-key',
                providerCreditId: 'credit-1',
                status: 'consumed',
            },
        });
        expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-a',
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 3,
            },
            serviceId: 'openai-codex',
            profileId: 'work',
            providerCreditId: 'credit-1',
            sourceSnapshotFetchedAtMs: 1_234,
        });
        expect(getQuotaSnapshotEntry(key).snapshot?.fetchedAt).toBe(1_235);
    });

    it('admits read, refresh, and recovery operations before every legacy network effect', async () => {
        const {
            buildQuotaSnapshotScopeKey,
            consumeQuotaRecoveryCredit,
            refreshQuotaSnapshot,
            retainQuotaSnapshotPolling,
        } = await import('./connectedServiceQuotaSnapshotStore');
        const assertOperationAllowed = vi.fn(async (
            _operation: BuiltInLegacyConnectedAccountOperation,
        ) => {
            throw Object.assign(new Error('unsupported'), {
                code: 'connected_account_legacy_operation_unsupported',
            });
        });
        const ctx = {
            credentials: { token: 't', secret: 's' },
            credentialScope: 'scope',
            serverBasis: {
                serverId: 'server-a',
                generation: 3,
            },
            serviceId: 'openai-codex',
            profileId: 'work',
            resolveAccountMode: async () => 'plain' as const,
            assertOperationAllowed,
        } as const;
        const key = buildQuotaSnapshotScopeKey(
            ctx.credentialScope,
            ctx.serviceId,
            ctx.profileId,
        );

        const release = retainQuotaSnapshotPolling(key, ctx);
        await flushAsyncTurns();
        await refreshQuotaSnapshot(key, ctx);
        await consumeQuotaRecoveryCredit(key, {
            ...ctx,
            machineId: 'machine-1',
        });
        release();

        expect(assertOperationAllowed.mock.calls.map(([operation]) => (
            operation
        ))).toEqual([
            'quota_read',
            'quota_refresh',
            'recovery_credit_consume',
        ]);
        expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
        expect(getConnectedServiceQuotaSnapshotSealedSpy).not.toHaveBeenCalled();
        expect(
            requestConnectedServiceQuotaSnapshotRefreshSpy,
        ).not.toHaveBeenCalled();
        expect(
            requestConnectedServiceQuotaSnapshotRefreshV3Spy,
        ).not.toHaveBeenCalled();
        expect(
            connectedServiceQuotaRecoveryCreditConsumeSpy,
        ).not.toHaveBeenCalled();
    });

    it('selects the plain quota route before the first request and never falls back to the sealed route', async () => {
        const {
            buildQuotaSnapshotScopeKey,
            refreshQuotaSnapshot,
            retainQuotaSnapshotPolling,
        } = await import('./connectedServiceQuotaSnapshotStore');
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(null);
        requestConnectedServiceQuotaSnapshotRefreshV3Spy.mockResolvedValue(
            false,
        );
        const ctx = {
            credentials: { token: 'plain-token', secret: 'plain-secret' },
            credentialScope: 'plain-scope',
            serverBasis: {
                serverId: 'server-a',
                generation: 3,
            },
            serviceId: 'openai-codex',
            profileId: 'work',
            resolveAccountMode: async () => 'plain' as const,
            assertOperationAllowed: async () => {},
        } as const;
        const key = buildQuotaSnapshotScopeKey(
            ctx.credentialScope,
            ctx.serviceId,
            ctx.profileId,
        );

        const release = retainQuotaSnapshotPolling(key, ctx);
        await flushAsyncTurns();

        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledWith(
            ctx.credentials,
            {
                serviceId: 'openai-codex',
                profileId: 'work',
            },
            {
                expectedActiveServer: ctx.serverBasis,
            },
        );
        expect(
            getConnectedServiceQuotaSnapshotSealedSpy,
        ).not.toHaveBeenCalled();

        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(
            buildSnapshot(1_235),
        );
        await refreshQuotaSnapshot(key, ctx);
        release();

        expect(
            requestConnectedServiceQuotaSnapshotRefreshV3Spy,
        ).toHaveBeenCalledOnce();
        expect(
            requestConnectedServiceQuotaSnapshotRefreshSpy,
        ).not.toHaveBeenCalled();
    });

    it('keeps independently retained credential scopes active concurrently', async () => {
        const {
            buildQuotaSnapshotScopeKey,
            getQuotaSnapshotEntry,
            retainQuotaSnapshotPolling,
        } = await import('./connectedServiceQuotaSnapshotStore');
        getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(
            async (credentials: Readonly<{ token: string }>) =>
                buildSnapshot(credentials.token === 'token-a' ? 1_001 : 2_001),
        );
        const createContext = (
            credentialScope: string,
            token: string,
            serverId: string,
        ) => ({
            credentials: { token, secret: `${token}-secret` },
            credentialScope,
            serverBasis: {
                serverId,
                generation: 3,
            },
            serviceId: 'openai-codex' as const,
            profileId: 'work',
            resolveAccountMode: async () => 'plain' as const,
            assertOperationAllowed: async () => {},
        });
        const first = createContext(
            'server-a/account-a',
            'token-a',
            'server-a',
        );
        const second = createContext(
            'server-b/account-b',
            'token-b',
            'server-b',
        );
        const firstKey = buildQuotaSnapshotScopeKey(
            first.credentialScope,
            first.serviceId,
            first.profileId,
        );
        const secondKey = buildQuotaSnapshotScopeKey(
            second.credentialScope,
            second.serviceId,
            second.profileId,
        );

        const releaseFirst = retainQuotaSnapshotPolling(firstKey, first);
        const releaseSecond = retainQuotaSnapshotPolling(secondKey, second);
        await flushAsyncTurns();

        releaseFirst();
        releaseSecond();
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(
            2,
        );
        expect(getQuotaSnapshotEntry(firstKey).snapshot?.fetchedAt).toBe(1_001);
        expect(getQuotaSnapshotEntry(secondKey).snapshot?.fetchedAt).toBe(
            2_001,
        );
    });

    it('resolves the legacy quota route before the final peer admission and network effect', async () => {
        const {
            buildQuotaSnapshotScopeKey,
            refreshQuotaSnapshot,
            retainQuotaSnapshotPolling,
        } = await import('./connectedServiceQuotaSnapshotStore');
        let resolveMode!: (mode: 'plain') => void;
        let modePromise = new Promise<'plain'>((resolve) => {
            resolveMode = resolve;
        });
        const calls: string[] = [];
        const ctx = {
            credentials: { token: 'plain-token', secret: 'plain-secret' },
            credentialScope: 'server-a/plain-scope',
            serverBasis: {
                serverId: 'server-a',
                generation: 3,
            },
            serviceId: 'openai-codex',
            profileId: 'work',
            resolveAccountMode: async () => await modePromise,
            assertOperationAllowed: async (
                operation: BuiltInLegacyConnectedAccountOperation,
            ) => {
                calls.push(`admit:${operation}`);
            },
        } as const;
        getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(
            async () => {
                calls.push('effect:quota_read');
                return buildSnapshot();
            },
        );
        requestConnectedServiceQuotaSnapshotRefreshV3Spy.mockImplementation(
            async () => {
                calls.push('effect:quota_refresh');
                return true;
            },
        );
        const key = buildQuotaSnapshotScopeKey(
            ctx.credentialScope,
            ctx.serviceId,
            ctx.profileId,
        );

        const release = retainQuotaSnapshotPolling(key, ctx);
        await flushAsyncTurns();
        expect(calls).toEqual([]);

        resolveMode('plain');
        await flushAsyncTurns();
        expect(calls.slice(0, 2)).toEqual([
            'admit:quota_read',
            'effect:quota_read',
        ]);

        calls.length = 0;
        modePromise = new Promise<'plain'>((resolve) => {
            resolveMode = resolve;
        });
        const refresh = refreshQuotaSnapshot(key, ctx);
        await flushAsyncTurns();
        expect(calls).toEqual([]);

        resolveMode('plain');
        await refresh;
        release();
        expect(calls.slice(0, 2)).toEqual([
            'admit:quota_refresh',
            'effect:quota_refresh',
        ]);
    });
});
