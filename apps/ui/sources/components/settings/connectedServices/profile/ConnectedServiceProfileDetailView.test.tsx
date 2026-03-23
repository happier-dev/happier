import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@/text';
import { renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();
const applySettingsSpy = vi.fn(async () => {});
const routeParams = { serviceId: 'openai-codex', profileId: 'work' };
const profileState = {
  connectedServicesV2: [
    {
      serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'me@example.com', providerAccountId: 'acct-1' }],
    },
  ],
};

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { back: backSpy, push: vi.fn() },
    });
    return {
        ...routerMock.module,
        useLocalSearchParams: () => routeParams,
        useGlobalSearchParams: () => routeParams,
    };
});

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: vi.fn(async () => null),
            alert: vi.fn(async () => {}),
            confirm: vi.fn(async () => false),
        },
    }).module;
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => featureId === 'connectedServices.quotas' || featureId === 'connectedServices',
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => profileState,
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

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
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
  beforeEach(() => {
    routeParams.serviceId = 'openai-codex';
    routeParams.profileId = 'work';
    applySettingsSpy.mockClear();
  });

  it('renders profile details and quota card when quotas are enabled', async () => {
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceProfileDetailView />)).tree;

    expect(tree.findAll((n) => n.props?.children === 'me@example.com').length).toBeGreaterThan(0);
    expect(tree.findAll((n) => n.props?.title === 'Refresh')).toHaveLength(1);
  });

  it('renders an unknown-profile guard state for nonexistent profile ids', async () => {
    routeParams.profileId = 'missing';
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceProfileDetailView />)).tree;

    expect(tree.findAll((n) => n.props?.title === t('connectedServices.detail.alerts.unknownProfileTitle'))).toHaveLength(1);
    expect(tree.findAll((n) => n.props?.title === t('connectedServices.detail.actionsGroupTitle'))).toHaveLength(0);
    expect(applySettingsSpy).not.toHaveBeenCalled();
  });
});
