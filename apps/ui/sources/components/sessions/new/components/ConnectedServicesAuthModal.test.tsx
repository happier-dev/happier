import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { ConnectedServiceQuotaSnapshotV1Schema, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';

import { ConnectedServicesAuthModal } from './ConnectedServicesAuthModal';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

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

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/sync/store/hooks', () => ({
  useSettings: () => useSettingsSpy(),
  useLocalSetting: () => 1,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));

describe('ConnectedServicesAuthModal', () => {
  it('renders connected profiles immediately when switching a service to connected mode', () => {
    const setBindingForService = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ConnectedServicesAuthModal
          onClose={() => {}}
          supportedServiceIds={['anthropic']}
          profileOptionsByServiceId={{
            anthropic: [{ profileId: 'work', status: 'connected', providerEmail: null }],
          }}
          bindingsByServiceId={{ anthropic: { source: 'native' } }}
          setBindingForService={setBindingForService}
          onOpenSettings={() => {}}
        />,
      );
    });

    expect(tree.root.findAll((n) => n.props?.title === 'work')).toHaveLength(0);

    const connectItem = tree.root.find((n) => n.props?.title === 'Use connected services');

    act(() => {
      connectItem.props.onPress?.();
    });

    expect(setBindingForService).toHaveBeenCalledWith('anthropic', expect.objectContaining({ source: 'connected' }));
    expect(tree.root.findAll((n) => n.props?.title === 'work')).toHaveLength(1);
  });

  it('selects the settings default profile when switching a service to connected mode', () => {
    const setBindingForService = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ConnectedServicesAuthModal
          onClose={() => {}}
          supportedServiceIds={['anthropic']}
          profileOptionsByServiceId={{
            anthropic: [
              { profileId: 'work', status: 'connected', providerEmail: null },
              { profileId: 'personal', status: 'connected', providerEmail: null },
            ],
          }}
          bindingsByServiceId={{ anthropic: { source: 'native' } }}
          setBindingForService={setBindingForService}
          defaultProfileIdByServiceId={{ anthropic: 'personal' }}
          onOpenSettings={() => {}}
        />,
      );
    });

    const connectItem = tree.root.find((n) => n.props?.title === 'Use connected services');
    act(() => {
      connectItem.props.onPress?.();
    });

    expect(setBindingForService).toHaveBeenCalledWith('anthropic', { source: 'connected', profileId: 'personal' });
    expect(tree.root.findAll((n) => n.props?.title === 'work')).toHaveLength(1);
    expect(tree.root.findAll((n) => n.props?.title === 'personal')).toHaveLength(1);
  });

  it('shows quota summary badges for pinned meters (non-blocking)', async () => {
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ConnectedServicesAuthModal
          onClose={() => {}}
          supportedServiceIds={['anthropic']}
          profileOptionsByServiceId={{
            anthropic: [{ profileId: 'work', status: 'connected', providerEmail: null }],
          }}
          bindingsByServiceId={{ anthropic: { source: 'connected', profileId: 'work' } }}
          setBindingForService={() => {}}
          onOpenSettings={() => {}}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(tree.root.findAll((n) => n.props?.children === 'Weekly 18%')).not.toHaveLength(0);
  });
});
