import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildProviderAccountUsageRecordId,
    ConnectedServiceQuotaSnapshotV1Schema,
    QualifiedConnectedAccountQuotaResponseV4Schema,
    QualifiedConnectedAccountQuotaSnapshotV4Schema,
    type AccountProfile,
    type QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import type { getQualifiedConnectedAccountQuotaV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';

import { renderHookAndCollectValues } from '../serverFeatureHookHarness.testHelpers';
import { __resetConnectedServiceQuotaSnapshotStore } from './connectedServiceQuotaSnapshotStore';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from './qualifiedConnectedAccountQuotaSnapshotStore';

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);
const useProfileSpy = vi.fn<() => Pick<AccountProfile, 'connectedAccountsV4' | 'connectedServicesV2'>>(() => ({
    connectedAccountsV4: [],
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
}));
const useSettingsSpy = vi.fn(() => ({
    connectedServicesQuotaPinnedMeterIdsByKey: {},
    connectedServicesQuotaSummaryStrategyByKey: {},
    connectedServicesProfileLabelByKey: {},
    connectedServicesDefaultProfileByServiceId: {},
}));

const {
    fetchAccountEncryptionModeSpy,
    getConnectedServiceQuotaSnapshotPlainSpy,
    getConnectedServiceQuotaSnapshotSealedSpy,
    getQualifiedConnectedAccountQuotaV4Spy,
} = vi.hoisted(() => ({
    fetchAccountEncryptionModeSpy: vi.fn<
        (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
    >(async () => ({ mode: 'plain', updatedAt: 0 })),
    getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
        (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
    >(async () => null),
    getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
        (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
    >(async () => null),
    getQualifiedConnectedAccountQuotaV4Spy: vi.fn<
        (...args: Parameters<typeof getQualifiedConnectedAccountQuotaV4>) => ReturnType<typeof getQualifiedConnectedAccountQuotaV4>
    >(async () => null),
}));

const serverFeaturesState = {
    current: {
        status: 'ready' as const,
        features: {
            capabilities: {
                connectedServices: {
                    credentialDelete: { revisionGuard: true },
                    qualifiedAccounts: undefined as { protocolVersion: number } | undefined,
                },
            },
        },
    },
};

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: stableCredentials }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    }),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesRuntimeSnapshot: () => serverFeaturesState.current,
}));

vi.mock('@/sync/store/hooks', async () => {
    const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
    return {
        ...actual,
        useAllMachines: () => [{ id: 'machine-a', active: true }],
        useProfile: () => useProfileSpy(),
        useSettingsSelector: <T,>(selector: (settings: ReturnType<typeof useSettingsSpy>) => T) => selector(useSettingsSpy()),
    };
});

vi.mock('@/sync/ops/connectedAccounts/connectedAccountDaemon', () => ({
    runConnectedAccountControlCommand: vi.fn(async (params: {
        command: { service: { pluginId: string; localId: string } };
    }) => ({
        status: 'described',
        service: params.command.service,
        operationTransport: params.command.service.pluginId === 'acme.connected.accounts'
            ? { kind: 'v4' }
            : {
                kind: 'legacy',
                peerClass: 'revisioned_v2_v3',
                serviceId: params.command.service.localId,
            },
    })),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/api/account/apiAccountEncryptionMode')>(),
    fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
    getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
}));

vi.mock('@/sync/api/account/apiQualifiedConnectedAccountsV4', () => ({
    getQualifiedConnectedAccountQuotaV4: getQualifiedConnectedAccountQuotaV4Spy,
}));

describe('useConnectedServiceQuotaSummaries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        serverFeaturesState.current.features.capabilities.connectedServices.qualifiedAccounts = undefined;
        // The quota store is module-level: without this reset a later case
        // silently reads the previous case's cached snapshot.
        __resetConnectedServiceQuotaSnapshotStore();
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
    });

    it('summarizes a novel qualified V4 account without falling through a scalar V2 service id', async () => {
        const ref = {
            service: {
                pluginId: 'acme.connected.accounts',
                localId: 'gateway',
            },
            accountId: 'work',
        } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        const snapshot = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
            v: 1,
            ref,
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: 'Acme Pro',
            accountLabel: null,
            activeAccountId: 'acme-work',
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
        getQualifiedConnectedAccountQuotaV4Spy.mockResolvedValue(
            QualifiedConnectedAccountQuotaResponseV4Schema.parse({
                ref,
                sourceResolution: {
                    source: { ref, bindingKind: 'account' },
                    recordId: buildProviderAccountUsageRecordId({
                        providerId: 'acme',
                        accountSubjectId: 'acme-work',
                        subjectKind: 'account',
                        quotaScope: 'account',
                    }),
                    providerAccountId: 'acme-work',
                    fetchedAt: 1,
                    staleAfterMs: 60_000,
                },
                content: { t: 'plain', v: snapshot },
                metadata: {
                    fetchedAt: 1,
                    staleAfterMs: 60_000,
                    status: 'ok',
                },
            }),
        );
        serverFeaturesState.current.features.capabilities.connectedServices.qualifiedAccounts = {
            protocolVersion: 4,
        };
        useProfileSpy.mockReturnValue({
            connectedAccountsV4: [account],
            connectedServicesV2: [],
        });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries());

        expect(seen.at(-1)?.hasConnectedProfiles).toBe(true);
        expect(seen.at(-1)?.summaries).toHaveLength(1);
        expect(seen.at(-1)?.summaries[0]).toMatchObject({
            service: ref.service,
            profileId: 'work',
            fetchedAt: 1,
        });
        expect(getQualifiedConnectedAccountQuotaV4Spy).toHaveBeenCalledWith(
            stableCredentials,
            ref,
            expect.objectContaining({
                expectedActiveServer: { serverId: 'server-a', generation: 1 },
            }),
        );
        expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
        expect(getConnectedServiceQuotaSnapshotSealedSpy).not.toHaveBeenCalled();
    });

    it('carries each account\'s name, email and id as they are (the one presenter hides them) and groups it under its provider', async () => {
        const ref = { service: { pluginId: 'acme.connected.accounts', localId: 'gateway' }, accountId: 'acct_9f2c' } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
            providerIdentity: { email: 'kevin@gmail.com' },
        } satisfies QualifiedConnectedAccountProfileV4;
        const snapshot = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
            v: 1, ref, fetchedAt: 5, staleAfterMs: 60_000, planLabel: 'Pro', accountLabel: null, activeAccountId: 'acct_9f2c',
            meters: [{
                meterId: 'weekly', label: 'Weekly', used: 40, limit: 100, unit: 'count', utilizationPct: null,
                resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'usage_limit' },
            }],
        });
        getQualifiedConnectedAccountQuotaV4Spy.mockResolvedValue(QualifiedConnectedAccountQuotaResponseV4Schema.parse({
            ref,
            sourceResolution: {
                source: { ref, bindingKind: 'account' },
                recordId: buildProviderAccountUsageRecordId({
                    providerId: 'acme', accountSubjectId: 'acct_9f2c', subjectKind: 'account', quotaScope: 'account',
                }),
                providerAccountId: 'acct_9f2c',
                fetchedAt: 5,
                staleAfterMs: 60_000,
            },
            content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: 5, staleAfterMs: 60_000, status: 'ok' },
        }));
        serverFeaturesState.current.features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        useProfileSpy.mockReturnValue({ connectedAccountsV4: [account], connectedServicesV2: [] });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }));

        // Identity display follows the device's "Hide account emails and IDs" through
        // `presentConnectedAccountIdentity`; the summary never masks on its own.
        expect(seen.at(-1)?.summaries[0]).toMatchObject({
            accountLabel: null,
            accountEmail: 'kevin@gmail.com',
            accountId: 'acct_9f2c',
            serviceGroupKey: 'acme.connected.accounts/gateway',
        });
    });

    it('names a built-in service by its own name before its descriptor projection arrives, never "Connected service"', async () => {
        const { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } = await import('@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility');
        const { resolveConnectedServiceDisplayName } = await import('@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName');
        const { t } = await import('@/text');
        const [legacyServiceId, compatibility] = Object.entries(BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID)[0]!;
        const ref = { service: compatibility.service, accountId: '97bd5614-8970-4068-87f0-1d2c3b4a5e6f' } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        const snapshot = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
            v: 1, ref, fetchedAt: 5, staleAfterMs: 60_000, planLabel: null, accountLabel: null, activeAccountId: ref.accountId,
            meters: [{
                meterId: 'weekly', label: 'Weekly', used: 40, limit: 100, unit: 'count', utilizationPct: null,
                resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'usage_limit' },
            }],
        });
        getQualifiedConnectedAccountQuotaV4Spy.mockResolvedValue(QualifiedConnectedAccountQuotaResponseV4Schema.parse({
            ref,
            sourceResolution: {
                source: { ref, bindingKind: 'account' },
                recordId: buildProviderAccountUsageRecordId({
                    providerId: 'acme', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account',
                }),
                providerAccountId: ref.accountId,
                fetchedAt: 5,
                staleAfterMs: 60_000,
            },
            content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: 5, staleAfterMs: 60_000, status: 'ok' },
        }));
        serverFeaturesState.current.features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        useProfileSpy.mockReturnValue({ connectedAccountsV4: [account], connectedServicesV2: [] });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }));

        const named = resolveConnectedServiceDisplayName(legacyServiceId, t);
        expect(named).not.toBe(t('connectedServices.fallbackName'));
        expect(seen.at(-1)?.summaries[0]).toMatchObject({ serviceLabel: named, legacyServiceId });
    });

    it('says which connected accounts have no usage yet: still being read, or read and unavailable', async () => {
        const ref = { service: { pluginId: 'acme.connected.accounts', localId: 'gateway' }, accountId: 'work' } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        serverFeaturesState.current.features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        useProfileSpy.mockReturnValue({ connectedAccountsV4: [account], connectedServicesV2: [] });
        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');

        // The provider answers without usage: the read settled, so the account is unavailable.
        getQualifiedConnectedAccountQuotaV4Spy.mockResolvedValue(null);
        const settled = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }));
        expect(settled.at(-1)?.accountsWithoutUsage).toEqual([
            expect.objectContaining({ accountLabel: null, accountId: 'work', serviceGroupKey: 'acme.connected.accounts/gateway', state: 'unavailable' }),
        ]);

        // A read still in flight is loading, never "unavailable".
        const { __resetQualifiedConnectedAccountQuotaSnapshotStore } = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        getQualifiedConnectedAccountQuotaV4Spy.mockImplementation(() => new Promise(() => {}));
        const pending = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }));
        expect(pending.at(-1)?.accountsWithoutUsage).toEqual([expect.objectContaining({ state: 'loading' })]);
    });

    it('names the accounts that need a new sign-in, counts keys that report no limits, and marks the account a pool uses now', async () => {
        const service = { pluginId: 'acme.connected.accounts', localId: 'gateway' } as const;
        const profile = (accountId: string, fields: Partial<QualifiedConnectedAccountProfileV4>): QualifiedConnectedAccountProfileV4 => ({
            ref: { service, accountId },
            status: 'connected',
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
            ...fields,
        } as QualifiedConnectedAccountProfileV4);
        const signedOut = profile('work', { status: 'needs_reauth', providerIdentity: { email: 'leeroy@company.com' } });
        const key = profile('build', { kind: 'token' });
        const personal = profile('personal', {});
        serverFeaturesState.current.features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        useProfileSpy.mockReturnValue({
            connectedAccountsV4: [signedOut, key, personal],
            connectedServicesV2: [],
            connectedAccountGroupsV4: [{ ref: { service, groupId: 'pool' }, activeConnectedAccountId: 'personal', members: [] }],
        } as never);
        getQualifiedConnectedAccountQuotaV4Spy.mockResolvedValue(null);
        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');

        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }));
        const last = seen.at(-1)!;

        expect(last.accountsNeedingSignIn).toEqual([
            expect.objectContaining({ accountEmail: 'leeroy@company.com', accountId: 'work', ref: { service, accountId: 'work' } }),
        ]);
        // A key reports no limits: counted once, never listed as "unavailable".
        expect(last.keysWithoutLimits).toBe(1);
        expect(last.accountsWithoutUsage.map((account) => account.accountId)).toEqual(['personal']);
        expect(last.inUseAccountKeys).toEqual(new Set(['acme.connected.accounts%2Fgateway/personal']));
    });

    it('reads only the cache when asked, never the server, and says when each summary was read', async () => {
        const ref = { service: { pluginId: 'acme.connected.accounts', localId: 'gateway' }, accountId: 'work' } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        serverFeaturesState.current.features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        useProfileSpy.mockReturnValue({ connectedAccountsV4: [account], connectedServicesV2: [] });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'cache_only' }));

        expect(seen.at(-1)?.hasConnectedProfiles).toBe(true);
        expect(seen.at(-1)?.summaries).toEqual([]);
        // Nothing was read, so nothing is claimed about the account.
        expect(seen.at(-1)?.accountsWithoutUsage).toEqual([]);
        expect(getQualifiedConnectedAccountQuotaV4Spy).not.toHaveBeenCalled();
    });

    it('reads the server once per launch when asked to load once, however many surfaces mount', async () => {
        const ref = { service: { pluginId: 'acme.connected.accounts', localId: 'gateway' }, accountId: 'work' } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        serverFeaturesState.current.features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        useProfileSpy.mockReturnValue({ connectedAccountsV4: [account], connectedServicesV2: [] });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }));
        await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }));

        expect(getQualifiedConnectedAccountQuotaV4Spy).toHaveBeenCalledTimes(1);
    });

    it('preserves pinned meter order for primary summaries', async () => {
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({
            connectedAccountsV4: [],
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'work',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
        });
        useSettingsSpy.mockReturnValue({
            connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['monthly', 'weekly'] },
            connectedServicesQuotaSummaryStrategyByKey: { 'anthropic/work': 'primary' },
            connectedServicesProfileLabelByKey: {},
            connectedServicesDefaultProfileByServiceId: {},
        });
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'anthropic',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: 'Pro',
            accountLabel: null,
            meters: [
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 82,
                    limit: 100,
                    unit: 'count',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    details: {},
                },
                {
                    meterId: 'monthly',
                    label: 'Monthly',
                    used: 44,
                    limit: 100,
                    unit: 'count',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    details: {},
                },
            ],
        }));

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries());

        const last = seen.at(-1);
        expect(last?.summaries[0]?.primaryMeter?.meterId).toBe('monthly');
        expect(last?.summaries[0]?.meters.map((meter) => meter.meterId)).toEqual(['monthly', 'weekly']);
    });

    it('projects the provider-reported remaining percentage, not one derived from utilization', async () => {
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({
            connectedAccountsV4: [],
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'work',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
        });
        useSettingsSpy.mockReturnValue({
            connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
            connectedServicesQuotaSummaryStrategyByKey: { 'anthropic/work': 'primary' },
            connectedServicesProfileLabelByKey: {},
            connectedServicesDefaultProfileByServiceId: {},
        });
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'anthropic',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: 'Pro',
            accountLabel: null,
            meters: [
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 40,
                    limit: 100,
                    unit: 'count',
                    // The provider reports both; remaining is authoritative and
                    // is NOT the complement of the reported utilization.
                    utilizationPct: 90,
                    remainingPct: 25,
                    resetsAt: null,
                    status: 'ok',
                    details: { limitCategory: 'usage_limit' },
                },
            ],
        }));

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries());

        expect(seen.at(-1)?.summaries[0]?.primaryMeter?.remainingPct).toBe(25);
    });

    it('ranks min-remaining summaries only across comparable meters', async () => {
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({
            connectedAccountsV4: [],
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'work',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
        });
        useSettingsSpy.mockReturnValue({
            connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly', 'burst'] },
            connectedServicesQuotaSummaryStrategyByKey: { 'anthropic/work': 'min_remaining' },
            connectedServicesProfileLabelByKey: {},
            connectedServicesDefaultProfileByServiceId: {},
        });
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'anthropic',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: 'Pro',
            accountLabel: null,
            meters: [
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 40,
                    limit: 100,
                    unit: 'count',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    details: { limitCategory: 'usage_limit' },
                },
                {
                    meterId: 'burst',
                    label: 'Burst',
                    used: 95,
                    limit: 100,
                    unit: 'requests',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    details: { limitCategory: 'rate_limit' },
                },
            ],
        }));

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries());

        // A rate-limit meter in another comparable family must not become the
        // headline number just because it has less remaining.
        expect(seen.at(-1)?.summaries[0]?.primaryMeter?.meterId).toBe('weekly');
        expect(seen.at(-1)?.summaries[0]?.meters.map((meter) => meter.meterId))
            .toEqual(['weekly', 'burst']);
    });

    it('requests summaries for retryable refresh-failure profiles because they remain usable', async () => {
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({
            connectedAccountsV4: [],
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'retryable',
                            status: 'refresh_failed_retryable',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
        });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries());

        expect(seen.at(-1)?.hasConnectedProfiles).toBe(true);
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ serviceId: 'anthropic', profileId: 'retryable' }),
            expect.objectContaining({
                expectedActiveServer: { serverId: 'server-a', generation: 1 },
            }),
        );
    });

    it('still requests summaries for an empty/unknown status (fails OPEN) and skips only explicit needs_reauth', async () => {
        // Usage DISPLAY fails open: absent/'' status must not silently drop a
        // healthy profile from quota summaries; only an explicit, recognized
        // needs_reauth is excluded (shouldHideQuotaForCredentialStatus fold).
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({
            connectedAccountsV4: [],
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'unknown-status',
                            // Raw wire value outside the typed enum — the display gate must fail OPEN.
                            status: '' as unknown as 'connected',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                        {
                            profileId: 'reauth',
                            status: 'needs_reauth',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
        });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries());

        expect(seen.at(-1)?.hasConnectedProfiles).toBe(true);
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ serviceId: 'anthropic', profileId: 'unknown-status' }),
            expect.objectContaining({
                expectedActiveServer: { serverId: 'server-a', generation: 1 },
            }),
        );
        expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ profileId: 'reauth' }),
            expect.anything(),
        );
    });
});
