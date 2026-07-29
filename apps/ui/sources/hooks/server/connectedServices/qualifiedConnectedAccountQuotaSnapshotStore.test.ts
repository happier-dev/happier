import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    getQuotaMock,
    requestRefreshMock,
    openQuotaMock,
} = vi.hoisted(() => ({
    getQuotaMock: vi.fn(),
    requestRefreshMock: vi.fn(),
    openQuotaMock: vi.fn(),
}));

vi.mock('@/sync/api/account/apiQualifiedConnectedAccountsV4', () => ({
    getQualifiedConnectedAccountQuotaV4: getQuotaMock,
    requestQualifiedConnectedAccountQuotaRefreshV4: requestRefreshMock,
}));

vi.mock(
    '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials',
    () => ({
        resolveAccountScopedCryptoMaterialFromCredentials: () => ({
            type: 'legacy',
        }),
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

function buildContext(serverId: string, generation: number) {
    return {
        credentials,
        credentialScope: `${serverId}\u0000credentials`,
        ref,
        serverBasis: {
            serverId,
            generation,
        },
        assertOperationAllowed: vi.fn(async () => {}),
    };
}

async function flushAsyncTurns(turns = 8): Promise<void> {
    for (let index = 0; index < turns; index += 1) {
        await Promise.resolve();
    }
}

describe('qualifiedConnectedAccountQuotaSnapshotStore', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const { __resetQualifiedConnectedAccountQuotaSnapshotStore } =
            await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
    });

    it('deduplicates the qualified read across concurrent consumers', async () => {
        const response = { ref };
        const snapshot = {
            v: 1,
            ref,
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        };
        getQuotaMock.mockResolvedValue(response);
        openQuotaMock.mockReturnValue(snapshot);
        const {
            buildQualifiedQuotaSnapshotScopeKey,
            getQualifiedQuotaSnapshotEntry,
            retainQualifiedQuotaSnapshotPolling,
        } = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = buildQualifiedQuotaSnapshotScopeKey(context);

        const releaseFirst =
            retainQualifiedQuotaSnapshotPolling(key, context);
        const releaseSecond =
            retainQualifiedQuotaSnapshotPolling(key, context);
        await flushAsyncTurns();

        expect(getQuotaMock).toHaveBeenCalledOnce();
        expect(getQualifiedQuotaSnapshotEntry(key)).toEqual(
            expect.objectContaining({
                snapshot,
                supported: true,
                loading: false,
                error: null,
            }),
        );
        releaseFirst();
        releaseSecond();
    });

    it('isolates cache identity by active-server generation', async () => {
        getQuotaMock.mockImplementation(
            async (_credentials, _ref, options) => ({
                ref,
                serverId: options?.expectedActiveServer?.serverId,
            }),
        );
        openQuotaMock.mockImplementation(({ response }) => ({
            v: 1,
            ref,
            fetchedAt: response.serverId === 'server-b' ? 2 : 1,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [{
                meterId: response.serverId,
                label: response.serverId,
                used: 0,
                limit: 1,
                unit: 'count',
                utilizationPct: 0,
                resetsAt: null,
                status: 'ok',
                confidence: 'exact',
                details: {},
            }],
        }));
        const {
            buildQualifiedQuotaSnapshotScopeKey,
            getQualifiedQuotaSnapshotEntry,
            retainQualifiedQuotaSnapshotPolling,
        } = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const serverA = buildContext('server-a', 1);
        const serverB = buildContext('server-b', 2);
        const keyA = buildQualifiedQuotaSnapshotScopeKey(serverA);
        const keyB = buildQualifiedQuotaSnapshotScopeKey(serverB);

        const releaseA = retainQualifiedQuotaSnapshotPolling(keyA, serverA);
        await flushAsyncTurns();
        const releaseB = retainQualifiedQuotaSnapshotPolling(keyB, serverB);
        await flushAsyncTurns();

        expect(keyB).not.toBe(keyA);
        expect(
            getQualifiedQuotaSnapshotEntry(keyA)
                .snapshot?.meters[0]?.meterId,
        ).toBe('server-a');
        expect(
            getQualifiedQuotaSnapshotEntry(keyB)
                .snapshot?.meters[0]?.meterId,
        ).toBe('server-b');
        releaseA();
        releaseB();
    });
});
