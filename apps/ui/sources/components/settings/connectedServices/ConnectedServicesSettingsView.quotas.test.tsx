import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installConnectedServicesCommonModuleMocks();

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

const {
  fetchAccountEncryptionModeSpy,
  getConnectedServiceQuotaSnapshotPlainSpy,
  getConnectedServiceQuotaSnapshotSealedSpy,
} = vi.hoisted(() => ({
  fetchAccountEncryptionModeSpy: vi.fn<
    (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
  >(async () => ({ mode: 'e2ee' as const, updatedAt: 0 })),
  getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
  >(async () => null),
  getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
  >(async () => null),
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
    tree = (await renderScreen(<ConnectedServicesSettingsView />)).tree;

    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(tree.findAll((n) => n.props?.children === 'Weekly 18%')).not.toHaveLength(0);
  });
});
