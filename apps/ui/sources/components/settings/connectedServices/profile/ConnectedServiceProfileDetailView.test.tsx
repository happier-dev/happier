import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: backSpy, push: vi.fn() }),
  useLocalSearchParams: () => ({ serviceId: 'openai-codex', profileId: 'work' }),
}));

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(async () => null),
    alert: vi.fn(async () => {}),
    confirm: vi.fn(async () => false),
  },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => featureId === 'connectedServices.quotas' || featureId === 'connectedServices',
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => ({
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'me@example.com', providerAccountId: 'acct-1' }],
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

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}), applySettings: vi.fn(async () => {}) },
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
  deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'e2ee', updatedAt: 0 })),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
  requestConnectedServiceQuotaSnapshotRefresh: vi.fn(async () => true),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
  getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
  requestConnectedServiceQuotaSnapshotRefreshV3: vi.fn(async () => true),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

describe('ConnectedServiceProfileDetailView', () => {
  it('renders profile details and quota card when quotas are enabled', async () => {
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceProfileDetailView />);
    });

    expect(tree.root.findAll((n) => n.props?.children === 'me@example.com').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n) => n.props?.title === 'Refresh')).toHaveLength(1);
  });
});
