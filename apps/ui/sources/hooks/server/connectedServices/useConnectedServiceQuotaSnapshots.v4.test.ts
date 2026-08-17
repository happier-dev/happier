import {
    buildProviderAccountUsageRecordId,
    QualifiedConnectedAccountQuotaResponseV4Schema,
    QualifiedConnectedAccountQuotaSnapshotV4Schema,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

const credentials = {
    token: 'token',
    secret: Buffer.from(new Uint8Array(32).fill(4)).toString('base64url'),
} as const;
const ref = {
    service: {
        pluginId: 'happier.agent.claude',
        localId: 'anthropic',
    },
    accountId: 'work',
} as const;
const account = {
    ref,
    status: 'connected',
    authenticationModeId: 'api-key',
    credentialRevision: 'revision-1',
    configurationReady: true,
    configurationRevision: null,
    scopes: [],
} as const;
const recordKey = {
    providerId: 'anthropic',
    accountSubjectId: 'provider-account',
    subjectKind: 'account',
    quotaScope: 'account',
} as const;
const snapshot = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
    v: 1,
    ref,
    fetchedAt: 1,
    staleAfterMs: 60_000,
    planLabel: 'Pro',
    accountLabel: null,
    activeAccountId: 'provider-account',
    meters: [{
        meterId: 'weekly',
        label: 'Weekly',
        used: 40,
        limit: 100,
        unit: 'count',
        utilizationPct: null,
        resetsAt: null,
        status: 'ok',
        confidence: 'exact',
        details: { limitCategory: 'usage_limit' },
    }],
});
const response = QualifiedConnectedAccountQuotaResponseV4Schema.parse({
    ref,
    sourceResolution: {
        source: {
            ref,
            bindingKind: 'account',
        },
        recordId: buildProviderAccountUsageRecordId(recordKey),
        providerAccountId: 'provider-account',
        fetchedAt: 1,
        staleAfterMs: 60_000,
    },
    content: {
        t: 'plain',
        v: snapshot,
    },
    metadata: {
        fetchedAt: 1,
        staleAfterMs: 60_000,
        status: 'ok',
    },
});
const serverBSnapshot = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
    ...snapshot,
    fetchedAt: 2,
    meters: [{
        ...snapshot.meters[0]!,
        meterId: 'server-b',
        label: 'Server B',
    }],
});
const serverBResponse = QualifiedConnectedAccountQuotaResponseV4Schema.parse({
    ...response,
    sourceResolution: {
        ...response.sourceResolution,
        fetchedAt: 2,
    },
    content: {
        t: 'plain',
        v: serverBSnapshot,
    },
    metadata: {
        ...response.metadata,
        fetchedAt: 2,
    },
});
const activeServerSnapshotState = {
    current: {
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    },
};

const {
    getLegacyPlainSpy,
    getLegacySealedSpy,
    getQualifiedSpy,
    requestQualifiedRefreshSpy,
    operationAdmissionSpy,
} = vi.hoisted(() => ({
    getLegacyPlainSpy: vi.fn(async () => null),
    getLegacySealedSpy: vi.fn(async () => null),
    getQualifiedSpy: vi.fn(),
    requestQualifiedRefreshSpy: vi.fn(async () => {}),
    operationAdmissionSpy: vi.fn(async () => {}),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshotState.current,
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({
        connectedAccountsV4: [account],
    }),
}));

const serverFeaturesState = {
    current: {
        status: 'ready',
        features: {
            capabilities: {
                connectedServices: {
                    credentialDelete: { revisionGuard: true },
                    qualifiedAccounts: { protocolVersion: 4 },
                },
            },
        },
    },
};

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesRuntimeSnapshot: () => serverFeaturesState.current,
}));

vi.mock('./useCredentialScopedAccountModeResolver', () => ({
    useCredentialScopedAccountModeResolver: () => async () => 'plain',
}));

vi.mock('./useConnectedServiceLegacyOperationAdmission', () => ({
    useConnectedServiceLegacyOperationAdmission: () => async () => {},
    useConnectedAccountOperationAdmission: () => operationAdmissionSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
    getConnectedServiceQuotaSnapshotSealed: getLegacySealedSpy,
    requestConnectedServiceQuotaSnapshotRefresh: vi.fn(async () => true),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: getLegacyPlainSpy,
    requestConnectedServiceQuotaSnapshotRefreshV3: vi.fn(async () => true),
}));

vi.mock('@/sync/api/account/apiQualifiedConnectedAccountsV4', () => ({
    getQualifiedConnectedAccountQuotaV4: getQualifiedSpy,
    requestQualifiedConnectedAccountQuotaRefreshV4:
        requestQualifiedRefreshSpy,
}));

describe('useConnectedServiceQuotaSnapshots V4 transport', () => {
    beforeEach(async () => {
        standardCleanup();
        vi.clearAllMocks();
        activeServerSnapshotState.current = {
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        };
        serverFeaturesState.current = {
            status: 'ready',
            features: {
                capabilities: {
                    connectedServices: {
                        credentialDelete: { revisionGuard: true },
                        qualifiedAccounts: { protocolVersion: 4 },
                    },
                },
            },
        };
        getQualifiedSpy.mockResolvedValue(response);
        const { __resetConnectedServiceQuotaSnapshotStore } = await import(
            './connectedServiceQuotaSnapshotStore'
        );
        __resetConnectedServiceQuotaSnapshotStore();
        const { __resetQualifiedConnectedAccountQuotaSnapshotStore } =
            await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
    });

    it('uses the exact qualified V4 quota identity without issuing a legacy request', async () => {
        const { useConnectedServiceQuotaSnapshots } = await import(
            './useConnectedServiceQuotaSnapshots'
        );
        const hook = await renderHook(() =>
            useConnectedServiceQuotaSnapshots([{
                serviceId: 'anthropic',
                profileId: 'work',
            }]));
        await flushHookEffects({ cycles: 8, turns: 8 });

        expect(getQualifiedSpy).toHaveBeenCalledWith(
            credentials,
            ref,
            expect.objectContaining({
                expectedActiveServer: expect.objectContaining({
                    serverId: 'server-a',
                    generation: 1,
                }),
            }),
        );
        expect(getLegacyPlainSpy).not.toHaveBeenCalled();
        expect(getLegacySealedSpy).not.toHaveBeenCalled();
        expect(operationAdmissionSpy).toHaveBeenCalledWith(
            ref.service,
            { kind: 'v4' },
            'quota_read',
        );
        expect(
            hook.getCurrent().snapshotsByKey['anthropic/work']
                ?.meters[0]?.meterId,
        ).toBe('weekly');
        await hook.unmount();
    });

    it('polls a novel qualified account without inventing a legacy service id', async () => {
        const novelRef = {
            service: {
                pluginId: 'acme.connected.accounts',
                localId: 'gateway',
            },
            accountId: 'work',
        } as const;
        const novelSnapshot = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
            ...snapshot,
            ref: novelRef,
        });
        getQualifiedSpy.mockResolvedValue(QualifiedConnectedAccountQuotaResponseV4Schema.parse({
            ...response,
            ref: novelRef,
            sourceResolution: {
                ...response.sourceResolution,
                source: {
                    ...response.sourceResolution.source,
                    ref: novelRef,
                },
            },
            content: { t: 'plain', v: novelSnapshot },
        }));
        const { useConnectedServiceQuotaSnapshots } = await import(
            './useConnectedServiceQuotaSnapshots'
        );
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{
            ref: novelRef,
        }]));
        await flushHookEffects({ cycles: 8, turns: 8 });

        const key = 'acme.connected.accounts%2Fgateway/work';
        expect(getQualifiedSpy).toHaveBeenCalledWith(credentials, novelRef, expect.anything());
        expect(getLegacyPlainSpy).not.toHaveBeenCalled();
        expect(getLegacySealedSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().profiles).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'qualified', key, ref: novelRef }),
        ]));
        expect(hook.getCurrent().snapshotsByKey[key]).toEqual(
            expect.objectContaining({ ref: novelRef }),
        );
        await hook.unmount();
    });

    it('never exposes a prior-server V4 snapshot after the active server changes', async () => {
        getQualifiedSpy.mockImplementation(
            async (_credentials, _ref, options) =>
                options?.expectedActiveServer?.serverId === 'server-b'
                    ? serverBResponse
                    : response,
        );
        const { useConnectedServiceQuotaSnapshots } = await import(
            './useConnectedServiceQuotaSnapshots'
        );
        const hook = await renderHook(() =>
            useConnectedServiceQuotaSnapshots([{
                serviceId: 'anthropic',
                profileId: 'work',
            }]));
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(
            hook.getCurrent().snapshotsByKey['anthropic/work']
                ?.meters[0]?.meterId,
        ).toBe('weekly');

        activeServerSnapshotState.current = {
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            generation: 2,
        };
        await hook.rerender();
        expect(
            hook.getCurrent().snapshotsByKey['anthropic/work']
                ?.meters[0]?.meterId,
        ).not.toBe('weekly');
        await flushHookEffects({ cycles: 8, turns: 8 });

        expect(
            hook.getCurrent().snapshotsByKey['anthropic/work']
                ?.meters[0]?.meterId,
        ).toBe('server-b');
        expect(getQualifiedSpy).toHaveBeenLastCalledWith(
            credentials,
            ref,
            {
                expectedActiveServer: {
                    serverId: 'server-b',
                    generation: 2,
                },
            },
        );
        await hook.unmount();
    });

    it('issues no quota request when daemon operation evidence contradicts advertised V4', async () => {
        operationAdmissionSpy.mockRejectedValueOnce(Object.assign(
            new Error('unsupported'),
            { code: 'connected_account_v4_operation_unsupported' },
        ));
        const { useConnectedServiceQuotaSnapshots } = await import(
            './useConnectedServiceQuotaSnapshots'
        );
        const hook = await renderHook(() =>
            useConnectedServiceQuotaSnapshots([{
                serviceId: 'anthropic',
                profileId: 'work',
            }]));
        await flushHookEffects({ cycles: 8, turns: 8 });

        expect(getQualifiedSpy).not.toHaveBeenCalled();
        expect(getLegacyPlainSpy).not.toHaveBeenCalled();
        expect(getLegacySealedSpy).not.toHaveBeenCalled();
        expect(
            hook.getCurrent().snapshotsByKey['anthropic/work'],
        ).toBeNull();
        await hook.unmount();
    });

    it('performs no quota operation when the advertised qualified protocol is not 4', async () => {
        serverFeaturesState.current = {
            status: 'ready',
            features: {
                capabilities: {
                    connectedServices: {
                        credentialDelete: { revisionGuard: true },
                        qualifiedAccounts: { protocolVersion: 5 },
                    },
                },
            },
        };
        const { useConnectedServiceQuotaSnapshots } = await import(
            './useConnectedServiceQuotaSnapshots'
        );
        const hook = await renderHook(() =>
            useConnectedServiceQuotaSnapshots([{
                serviceId: 'anthropic',
                profileId: 'work',
            }]));
        await flushHookEffects({ cycles: 8, turns: 8 });

        expect(getQualifiedSpy).not.toHaveBeenCalled();
        expect(getLegacyPlainSpy).not.toHaveBeenCalled();
        expect(getLegacySealedSpy).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('shares one V4 quota entry between the list and detail readers', async () => {
        const { useConnectedServiceQuotaSnapshots } = await import(
            './useConnectedServiceQuotaSnapshots'
        );
        const { useQualifiedConnectedAccountQuota } = await import(
            './useQualifiedConnectedAccountQuota'
        );
        const hook = await renderHook(() => ({
            list: useConnectedServiceQuotaSnapshots([{
                serviceId: 'anthropic',
                profileId: 'work',
            }]),
            detail: useQualifiedConnectedAccountQuota(ref),
        }));
        await flushHookEffects({ cycles: 8, turns: 8 });

        expect(getQualifiedSpy).toHaveBeenCalledTimes(1);
        expect(
            hook.getCurrent().detail.snapshot?.meters[0]?.meterId,
        ).toBe('weekly');
        expect(
            hook.getCurrent().list.snapshotsByKey['anthropic/work']
                ?.meters[0]?.meterId,
        ).toBe('weekly');
        await hook.unmount();
    });
});
