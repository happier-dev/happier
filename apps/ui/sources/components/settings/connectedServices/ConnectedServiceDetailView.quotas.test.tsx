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
  useLocalSearchParams: () => ({ serviceId: 'openai-codex' }),
}));

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => ({
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'connected', providerEmail: null }],
        },
      ],
    }),
    useSettings: () => ({
      connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: {},
      connectedServicesQuotaSummaryStrategyByKey: {},
    }),
  };
});

const applySettingsSpy = vi.fn(async (_update: unknown) => {});
vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}), applySettings: applySettingsSpy },
}));

vi.mock('@/sync/api/account/apiConnectedServicesV2', () => ({
  deleteConnectedServiceCredential: vi.fn(async () => {}),
  registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
}));

const { getConnectedServiceQuotaSnapshotSealedSpy } = vi.hoisted(() => ({
  getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
  >(async () => null),
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));

describe('ConnectedServiceDetailView quotas', () => {
  const setFeatureFlags = (flags: Record<string, boolean>) => {
    useFeatureEnabledSpy.mockImplementation((featureId: string) => {
      if (featureId in flags) return Boolean(flags[featureId]);
      return true;
    });
  };

  it('shows quota card when feature is enabled', async () => {
    setFeatureFlags({ connectedServices: true, 'connectedServices.quotas': true });
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceDetailView />);
    });

    expect(tree.root.findAll((n) => n.props?.title === 'Refresh').length).toBeGreaterThan(0);
  });

  it('hides quota card when feature is disabled', async () => {
    setFeatureFlags({ connectedServices: true, 'connectedServices.quotas': false });
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceDetailView />);
    });

    expect(tree.root.findAll((n) => n.props?.title === 'Refresh')).toHaveLength(0);
  });

  it('does not expose connected services detail when the feature is disabled', async () => {
    setFeatureFlags({ connectedServices: false, 'connectedServices.quotas': true });
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceDetailView />);
    });

    const items = tree.root.findAll((n) => typeof n.props?.title === 'string' && typeof n.props?.onPress === 'function');
    expect(items.length).toBe(1);
  });

  it('persists pinned meter ids via settings when toggled', async () => {
    setFeatureFlags({ connectedServices: true, 'connectedServices.quotas': true });

    const secretBytes = new Uint8Array(32).fill(3);
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

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceDetailView />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const row = tree.root.find((n) => n.props?.meter?.meterId === 'weekly' && typeof n.props?.onTogglePin === 'function');
    await act(async () => {
      row.props.onTogglePin();
    });

    expect(applySettingsSpy).toHaveBeenCalledWith({
      connectedServicesQuotaPinnedMeterIdsByKey: { 'openai-codex/work': ['weekly'] },
    });
  });
});
