import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, type AccountProfile } from '@happier-dev/protocol';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';

import { renderHookAndCollectValues } from '../serverFeatureHookHarness.testHelpers';

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);
const useProfileSpy = vi.fn<() => Pick<AccountProfile, 'connectedServicesV2'>>(() => ({
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
}));
const useSettingsSpy = vi.fn(() => ({
    connectedServicesQuotaPinnedMeterIdsByKey: {},
    connectedServicesQuotaSummaryStrategyByKey: {},
    connectedServicesProfileLabelByKey: {},
    connectedServicesDefaultProfileByServiceId: {},
}));

const { fetchAccountEncryptionModeSpy, getConnectedServiceQuotaSnapshotPlainSpy, getConnectedServiceQuotaSnapshotSealedSpy } = vi.hoisted(() => ({
    fetchAccountEncryptionModeSpy: vi.fn<
        (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
    >(async () => ({ mode: 'plain', updatedAt: 0 })),
    getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
        (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
    >(async () => null),
    getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
        (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
    >(async () => null),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: stableCredentials }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/sync/store/hooks', async () => {
    const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
    return {
        ...actual,
        useProfile: () => useProfileSpy(),
        useSettings: () => useSettingsSpy(),
    };
});

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
    getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
}));

describe('useConnectedServiceQuotaSummaries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('preserves pinned meter order for primary summaries', async () => {
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({
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

    it('requests summaries for retryable refresh-failure profiles because they remain usable', async () => {
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({
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
        );
    });

    it('still requests summaries for an empty/unknown status (fails OPEN) and skips only explicit needs_reauth', async () => {
        // Usage DISPLAY fails open: absent/'' status must not silently drop a
        // healthy profile from quota summaries; only an explicit, recognized
        // needs_reauth is excluded (shouldHideQuotaForCredentialStatus fold).
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({
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
        );
        expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ profileId: 'reauth' }),
        );
    });
});
