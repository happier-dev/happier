import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol';
import type { connectedServiceQuotaRecoveryCreditConsume } from '@/sync/ops/connectedServiceQuotaRecoveryCredits';

const { consumeSpy } = vi.hoisted(() => ({
    consumeSpy: vi.fn<
        (...args: Parameters<typeof connectedServiceQuotaRecoveryCreditConsume>) =>
            ReturnType<typeof connectedServiceQuotaRecoveryCreditConsume>
    >(),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
    getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
    requestConnectedServiceQuotaSnapshotRefresh: vi.fn(async () => true),
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
    requestConnectedServiceQuotaSnapshotRefreshV3: vi.fn(async () => true),
}));
vi.mock('@/sync/domains/connectedServices/openConnectedServiceQuotaViewSnapshot', () => ({
    openConnectedServiceQuotaViewSnapshot: vi.fn(() => null),
}));
vi.mock('@/sync/ops/connectedServiceQuotaRecoveryCredits', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/connectedServiceQuotaRecoveryCredits')>(),
    connectedServiceQuotaRecoveryCreditConsume: consumeSpy,
}));

describe('connectedServiceQuotaSnapshotStore recovery-credit receipts', () => {
    beforeEach(async () => {
        const { __resetConnectedServiceQuotaSnapshotStore } = await import('@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore');
        __resetConnectedServiceQuotaSnapshotStore();
        vi.clearAllMocks();
    });

    it('returns the exact neutral receipt from the shared settings/session command owner', async () => {
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: 2,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        });
        consumeSpy.mockResolvedValue({
            ok: true,
            snapshot,
            receipt: { idempotencyKey: 'aggregate-key', status: 'nothing_to_reset' },
        });
        const { buildQuotaSnapshotScopeKey, consumeQuotaRecoveryCredit } = await import('@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore');
        const ctx = {
            credentials: { token: 't', secret: 's' },
            credentialScope: 'scope',
            serviceId: 'openai-codex',
            profileId: 'work',
            resolveAccountMode: async () => 'plain' as const,
        } as const;

        const result = await consumeQuotaRecoveryCredit(
            buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId),
            { ...ctx, machineId: 'machine-1' },
        );

        expect(result).toEqual({
            ok: true,
            receipt: { idempotencyKey: 'aggregate-key', status: 'nothing_to_reset' },
        });
        expect(consumeSpy).toHaveBeenCalledWith(expect.not.objectContaining({ providerCreditId: expect.anything() }));
    });
});
