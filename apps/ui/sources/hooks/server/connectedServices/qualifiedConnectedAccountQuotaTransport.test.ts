import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

const {
    getQuotaMock,
} = vi.hoisted(() => ({
    getQuotaMock: vi.fn(),
}));

vi.mock('@/sync/api/account/apiQualifiedConnectedAccountsV4', () => ({
    getQualifiedConnectedAccountQuotaV4: getQuotaMock,
}));

const credentials = {
    token: 'token',
    secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url'),
};
const tokenOnlyCredentials = {
    token: 'token-only',
};
const ref = {
    service: {
        pluginId: 'happier.agent.claude',
        localId: 'anthropic',
    },
    accountId: 'work',
};
const serverBasis = {
    serverId: 'server-a',
    generation: 4,
};
const snapshot = {
    v: 1,
    ref,
    activeAccountId: 'provider-work',
    fetchedAt: 1,
    staleAfterMs: 60_000,
    planLabel: null,
    accountLabel: null,
    meters: [],
    state: 'not_loaded' as const,
};
const response = {
    ref,
    sourceResolution: {
        source: { ref, bindingKind: 'account' },
        recordId: 'paug_v1_testrecord',
        providerAccountId: 'provider-work',
        fetchedAt: snapshot.fetchedAt,
        staleAfterMs: snapshot.staleAfterMs,
    },
    content: { t: 'plain', v: snapshot },
    metadata: { fetchedAt: 1, staleAfterMs: 60_000, status: 'ok' },
};

// Compile the real transport graph during collection, after the HTTP boundary
// is installed. The read's deadline must measure delivery/opening, not cold imports.
const { readQualifiedConnectedAccountQuota } = await import('@/sync/api/account/qualifiedConnectedAccountQuotaTransport');

describe('qualifiedConnectedAccountQuotaTransport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getQuotaMock.mockResolvedValue(response);
    });

    it('reads and opens V4 quota from the pinned server without a daemon admission', async () => {
        const callOrder: string[] = [];
        getQuotaMock.mockImplementation(async () => {
            callOrder.push('request');
            return response;
        });
        await expect(readQualifiedConnectedAccountQuota({
            credentials,
            ref,
            serverBasis,
        })).resolves.toEqual({ snapshot, recordId: 'paug_v1_testrecord', status: 'ok' });

        expect(callOrder).toEqual(['request']);
        expect(getQuotaMock).toHaveBeenCalledWith(credentials, ref, {
            expectedActiveServer: serverBasis,
        });
    });

    it('opens plain V4 quota for token-only credentials without resolving account encryption material', async () => {
        await expect(readQualifiedConnectedAccountQuota({
            credentials: tokenOnlyCredentials,
            ref,
            serverBasis,
        })).resolves.toEqual({ snapshot, recordId: 'paug_v1_testrecord', status: 'ok' });
    });

    it('keeps the typed not_loaded snapshot so observation-only accounts are not treated as missing', async () => {
        const unobserved = { ...response, content: { t: 'plain' as const, v: { ...snapshot, fetchedAt: 0 } },
            sourceResolution: { ...response.sourceResolution, fetchedAt: 0 }, metadata: { ...response.metadata, fetchedAt: 0, status: 'unavailable' as const } };
        getQuotaMock.mockResolvedValue(unobserved);
        await expect(readQualifiedConnectedAccountQuota({ credentials: tokenOnlyCredentials, ref, serverBasis }))
            .resolves.toMatchObject({ snapshot: { state: 'not_loaded', fetchedAt: 0 }, status: 'unavailable' });
    });

    it('projects a missing first observation into the typed not_loaded state', async () => {
        getQuotaMock.mockResolvedValue(null);
        await expect(readQualifiedConnectedAccountQuota({ credentials: tokenOnlyCredentials, ref, serverBasis }))
            .resolves.toMatchObject({
                snapshot: { ref, state: 'not_loaded', fetchedAt: 0, meters: [] },
                recordId: null,
                status: 'unavailable',
            });
    });

    it('rejects a quota response attributed to a different provider account', async () => {
        getQuotaMock.mockResolvedValue({
            ...response,
            sourceResolution: { ...response.sourceResolution, providerAccountId: 'another-provider-account' },
        });
        await expect(readQualifiedConnectedAccountQuota({
            credentials, ref, serverBasis,
        })).rejects.toMatchObject({ code: 'qualified_connected_account_quota_invalid' });
    });
});
