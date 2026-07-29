import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    getQuotaMock,
    requestRefreshMock,
    openQuotaMock,
    resolveMaterialMock,
} = vi.hoisted(() => ({
    getQuotaMock: vi.fn(),
    requestRefreshMock: vi.fn(),
    openQuotaMock: vi.fn(),
    resolveMaterialMock: vi.fn(),
}));

vi.mock('@/sync/api/account/apiQualifiedConnectedAccountsV4', () => ({
    getQualifiedConnectedAccountQuotaV4: getQuotaMock,
    requestQualifiedConnectedAccountQuotaRefreshV4: requestRefreshMock,
}));

vi.mock(
    '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials',
    () => ({
        resolveAccountScopedCryptoMaterialFromCredentials:
            resolveMaterialMock,
    }),
);

vi.mock('@happier-dev/protocol', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/protocol')>(),
    openQualifiedConnectedAccountQuotaResponseV4: openQuotaMock,
}));

const credentials = {
    token: 'token',
    secret: 'secret',
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
const response = {
    ref,
    content: {
        t: 'plain',
        v: {},
    },
    metadata: {
        fetchedAt: 1,
        staleAfterMs: 60_000,
        status: 'ok',
    },
};
const snapshot = {
    v: 1,
    ref,
    fetchedAt: 1,
    staleAfterMs: 60_000,
    planLabel: null,
    accountLabel: null,
    meters: [],
};

describe('qualifiedConnectedAccountQuotaTransport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveMaterialMock.mockReturnValue({ type: 'legacy' });
        getQuotaMock.mockResolvedValue(response);
        requestRefreshMock.mockResolvedValue(undefined);
        openQuotaMock.mockReturnValue(snapshot);
    });

    it('uses one admitted and server-pinned owner to read and open V4 quota', async () => {
        const callOrder: string[] = [];
        const assertOperationAllowed = vi.fn(async () => {
            callOrder.push('admit');
        });
        getQuotaMock.mockImplementation(async () => {
            callOrder.push('request');
            return response;
        });
        const { readQualifiedConnectedAccountQuota } = await import(
            './qualifiedConnectedAccountQuotaTransport'
        );

        await expect(readQualifiedConnectedAccountQuota({
            credentials,
            ref,
            serverBasis,
            assertOperationAllowed,
        })).resolves.toBe(snapshot);

        expect(callOrder).toEqual(['admit', 'request']);
        expect(assertOperationAllowed).toHaveBeenCalledWith('quota_read');
        expect(getQuotaMock).toHaveBeenCalledWith(credentials, ref, {
            expectedActiveServer: serverBasis,
        });
        expect(openQuotaMock).toHaveBeenCalledWith({
            response,
            expectedRef: ref,
            material: { type: 'legacy' },
        });
    });

    it('fails closed before read or refresh effects when admission rejects', async () => {
        const admissionError = Object.assign(new Error('unsupported'), {
            code: 'connected_account_v4_operation_unsupported',
        });
        const assertOperationAllowed = vi.fn(async () => {
            throw admissionError;
        });
        const {
            readQualifiedConnectedAccountQuota,
            refreshQualifiedConnectedAccountQuota,
        } = await import('./qualifiedConnectedAccountQuotaTransport');

        await expect(readQualifiedConnectedAccountQuota({
            credentials,
            ref,
            serverBasis,
            assertOperationAllowed,
        })).rejects.toBe(admissionError);
        await expect(refreshQualifiedConnectedAccountQuota({
            credentials,
            ref,
            serverBasis,
            assertOperationAllowed,
        })).rejects.toBe(admissionError);

        expect(getQuotaMock).not.toHaveBeenCalled();
        expect(requestRefreshMock).not.toHaveBeenCalled();
    });
});
