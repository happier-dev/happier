import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';

import { renderHookAndCollectValues } from '../serverFeatureHookHarness.testHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;

const useSettingsSpy = vi.fn(() => ({
  connectedServicesQuotaPinnedMeterIdsByKey: {},
  connectedServicesQuotaSummaryStrategyByKey: {},
  connectedServicesProfileLabelByKey: {},
  connectedServicesDefaultProfileByServiceId: {},
}));

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);

const { getConnectedServiceQuotaSnapshotSealedSpy } = vi.hoisted(() => ({
  getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
  >(async () => null),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

vi.mock('@/sync/store/hooks', () => ({
  useSettings: () => useSettingsSpy(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));

describe('useConnectedServiceQuotaBadges', () => {
  it('returns badges for pinned meters after snapshot fetch', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const secretBytes = new Uint8Array(32).fill(3);
    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
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
      ],
    });

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material: { type: 'legacy', secret: secretBytes },
      payload: snapshot,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });

    useSettingsSpy.mockReturnValue({
      connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
      connectedServicesQuotaSummaryStrategyByKey: {},
      connectedServicesProfileLabelByKey: {},
      connectedServicesDefaultProfileByServiceId: {},
    });

    getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue({
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
    });

    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaBadges([
      { serviceId: 'anthropic', profileId: 'work' },
    ]));

    const last = seen.at(-1) ?? {};
    expect(last['anthropic/work']?.map((b) => b.text)).toContain('Weekly 18%');
  });
});
