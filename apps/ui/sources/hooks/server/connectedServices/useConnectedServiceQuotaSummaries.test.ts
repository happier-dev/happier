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
        useSettings: () => useSettingsSpy(),
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

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
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
    beforeEach(async () => {
        vi.clearAllMocks();
        serverFeaturesState.current.features.capabilities.connectedServices.qualifiedAccounts = undefined;
        // The quota store is module-level: without this reset a later case
        // silently reads the previous case's cached snapshot.
        const { __resetConnectedServiceQuotaSnapshotStore } = await import('./connectedServiceQuotaSnapshotStore');
        __resetConnectedServiceQuotaSnapshotStore();
        const { __resetQualifiedConnectedAccountQuotaSnapshotStore } = await import(
            './qualifiedConnectedAccountQuotaSnapshotStore'
        );
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
        expect(seen.at(-1)?.summaries[0]?.meters.map((meter) => meter.meterId))
            .toEqual(['weekly']);
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
