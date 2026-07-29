import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { ConnectedServiceQuotaSnapshotV1Schema, type AccountProfile } from '@happier-dev/protocol';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { invalidateUsageAnalyticsQueryCache } from '@/sync/api/account/useUsageAnalyticsQuery';

const authState = vi.hoisted(() => ({
    credentials: { token: 'test-token', secret: 'test-secret' },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: authState.credentials, isAuthenticated: true }),
}));

vi.mock('@/sync/api/account/apiUsage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/account/apiUsage')>();
    return {
        ...actual,
        getUsageForPeriod: vi.fn(async () => []),
    };
});

const useFeatureEnabledSpy = vi.fn((_featureId: string) => false);
const useProfileSpy = vi.fn<() => Pick<AccountProfile, 'connectedServicesV2'>>(() => ({
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
}));
const useSettingsSpy = vi.fn(() => ({
    connectedServicesDefaultProfileByServiceId: {},
    connectedServicesProfileLabelByKey: {},
    connectedServicesQuotaPinnedMeterIdsByKey: {},
    connectedServicesQuotaSummaryStrategyByKey: {},
}));

const { fetchAccountEncryptionModeSpy, getConnectedServiceQuotaSnapshotSealedSpy, getConnectedServiceQuotaSnapshotPlainSpy } = vi.hoisted(() => ({
    fetchAccountEncryptionModeSpy: vi.fn<
        (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
    >(async () => ({ mode: 'e2ee', updatedAt: 0 })),
    getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
        (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
    >(async () => null),
    getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
        (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
    >(async () => null),
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

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/features/featureDecisionRuntime')>();
    return {
        ...actual,
        useServerFeaturesRuntimeSnapshot: () => ({
            status: 'ready',
            features: {
                capabilities: {
                    connectedServices: {
                        credentialDelete: { revisionGuard: true },
                    },
                },
            },
        }),
    };
});

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
        operationTransport: {
            kind: 'legacy',
            peerClass: 'revisioned_v2_v3',
            serviceId: params.command.service.localId,
        },
    })),
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
    getConnectedServiceRegistryEntry: (serviceId: string) => ({
        serviceId,
        displayNameKey: serviceId === 'openai-codex'
            ? 'connectedServices.names.openaiCodex'
            : 'connectedServices.fallbackName',
    }),
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

afterEach(() => {
    invalidateUsageAnalyticsQueryCache();
});

describe('UsagePanel', () => {
    it('renders a session drilldown frame when scoped to a specific session', async () => {
        const { UsagePanel } = await import('./UsagePanel');
        const screen = await renderScreen(
            <UsagePanel sessionId="session-123" />,
        );

        expect(screen.findByTestId('usage-session-drilldown')).toBeTruthy();
        expect(screen.getTextContent()).toContain('session-123');
    });

    it('renders connected service quota cards when quota snapshots are available', async () => {
        useFeatureEnabledSpy.mockImplementation((featureId: string) => featureId !== 'connectedServices');
        useProfileSpy.mockReturnValue({
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [{
                        profileId: 'work',
                        status: 'connected',
                        kind: 'oauth',
                        providerEmail: null,
                        providerAccountId: null,
                        expiresAt: null,
                        lastUsedAt: null,
                        health: null,
                    }],
                    groups: [],
                },
            ],
        });
        useSettingsSpy.mockReturnValue({
            connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
            connectedServicesProfileLabelByKey: {},
            connectedServicesQuotaPinnedMeterIdsByKey: { 'openai-codex/work': ['weekly', 'monthly'] },
            connectedServicesQuotaSummaryStrategyByKey: { 'openai-codex/work': 'min_remaining' },
        });

        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
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
        });
        fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(snapshot);

        const { UsagePanel } = await import('./UsagePanel');
        const screen = await renderScreen(<UsagePanel />);

        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(useFeatureEnabledSpy).toHaveBeenCalledWith('connectedServices.quotas');
        expect(useFeatureEnabledSpy).not.toHaveBeenCalledWith('connectedServices');
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('Connected services');
        expect(screen.getTextContent()).toContain('Weekly');
    });

    it('renders quota cards for each connected profile, not only the default profile', async () => {
        useFeatureEnabledSpy.mockImplementation((featureId: string) => featureId !== 'connectedServices');
        useProfileSpy.mockReturnValue({
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
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
                        {
                            profileId: 'personal',
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
            connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
            connectedServicesProfileLabelByKey: {
                'openai-codex/work': 'Work',
                'openai-codex/personal': 'Personal',
            },
            connectedServicesQuotaPinnedMeterIdsByKey: {},
            connectedServicesQuotaSummaryStrategyByKey: {},
        });

        fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(async (_credentials, params) => {
            if (params.profileId === 'work') {
                return ConnectedServiceQuotaSnapshotV1Schema.parse({
                    v: 1,
                    serviceId: 'openai-codex',
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
                    ],
                });
            }

            return ConnectedServiceQuotaSnapshotV1Schema.parse({
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'personal',
                fetchedAt: 2,
                staleAfterMs: 60_000,
                planLabel: 'Plus',
                accountLabel: null,
                meters: [
                    {
                        meterId: 'daily',
                        label: 'Daily',
                        used: 20,
                        limit: 100,
                        unit: 'count',
                        utilizationPct: null,
                        resetsAt: null,
                        status: 'ok',
                        details: {},
                    },
                ],
            });
        });

        const { UsagePanel } = await import('./UsagePanel');
        const screen = await renderScreen(<UsagePanel />);

        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(screen.getTextContent()).toContain('Work');
        expect(screen.getTextContent()).toContain('Personal');
        expect(screen.getTextContent()).toContain('Weekly');
        expect(screen.getTextContent()).toContain('Daily');
    });

    it('keeps the quota section visible when connected profiles exist but snapshots are unavailable', async () => {
        useFeatureEnabledSpy.mockImplementation((featureId: string) => featureId !== 'connectedServices');
        useProfileSpy.mockReturnValue({
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [{
                        profileId: 'work',
                        status: 'connected',
                        kind: 'oauth',
                        providerEmail: null,
                        providerAccountId: null,
                        expiresAt: null,
                        lastUsedAt: null,
                        health: null,
                    }],
                    groups: [],
                },
            ],
        });
        useSettingsSpy.mockReturnValue({
            connectedServicesDefaultProfileByServiceId: { anthropic: 'work' },
            connectedServicesProfileLabelByKey: {},
            connectedServicesQuotaPinnedMeterIdsByKey: {},
            connectedServicesQuotaSummaryStrategyByKey: {},
        });

        fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(null);

        const { UsagePanel } = await import('./UsagePanel');
        const screen = await renderScreen(<UsagePanel />);

        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(screen.findByTestId('usage-connected-services-quotas-section')).toBeTruthy();
        expect(screen.findByTestId('usage-connected-services-quotas-empty')).toBeTruthy();
    });
});
