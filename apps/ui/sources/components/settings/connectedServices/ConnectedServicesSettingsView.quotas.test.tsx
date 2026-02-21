import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();
const pushSpy = vi.fn();

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: backSpy, push: pushSpy }),
}));

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

const useSettingsSpy = vi.fn(() => ({
  connectedServicesDefaultProfileByServiceId: { anthropic: 'work' },
  connectedServicesProfileLabelByKey: {},
  connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
  connectedServicesQuotaSummaryStrategyByKey: {},
}));

vi.mock('@/sync/store/hooks', () => ({
  useProfile: () => ({
    connectedServicesV2: [
      {
        serviceId: 'anthropic',
        profiles: [{ profileId: 'work', status: 'connected', providerEmail: null }],
      },
    ],
  }),
  useSettings: () => useSettingsSpy(),
  useLocalSetting: () => 1,
}));

const { getConnectedServiceQuotaSnapshotSealedSpy } = vi.hoisted(() => ({
  getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
  >(async () => null),
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));

describe('ConnectedServicesSettingsView quotas', () => {
  it('shows quota badges on service rows when pinned meters exist', async () => {
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
    getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue({
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
    });

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServicesSettingsView />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(tree.root.findAll((n) => n.props?.children === 'Weekly 18%')).not.toHaveLength(0);
  });
});
