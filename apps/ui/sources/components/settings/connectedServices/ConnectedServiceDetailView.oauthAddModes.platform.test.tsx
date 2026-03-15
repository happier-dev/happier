import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pushSpy = vi.fn();

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: pushSpy }),
  useLocalSearchParams: () => ({ serviceId: 'claude-subscription' }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } }),
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(async () => null),
    alert: vi.fn(async () => {}),
    confirm: vi.fn(async () => false),
    alertAsync: vi.fn(async () => {}),
  },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => ({
      connectedServicesV2: [
        {
          serviceId: 'claude-subscription',
          profiles: [],
        },
      ],
    }),
    useSettings: () => ({
      connectedServicesDefaultProfileByServiceId: {},
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

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
  getConnectedServiceRegistryEntry: (serviceId: string) => ({
    serviceId,
    connectCommand: `happier connect ${serviceId}`,
    supportsOauth: true,
    oauthAddActionModes: ['paste', 'browser'],
    supportsToken: false,
  }),
}));

afterEach(() => {
  vi.resetModules();
});

describe('ConnectedServiceDetailView oauth add modes (platform)', () => {
  it('does not render embedded browser add method on web', async () => {
    vi.doMock('react-native', async () => {
      const actual = await vi.importActual<typeof import('react-native')>('react-native');
      return { ...actual, Platform: { ...actual.Platform, OS: 'web' } };
    });

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceDetailView />);
    });

    expect(tree.root.findAll((n) => n.props?.testID === 'connected-services-action:add-oauth-profile-paste').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n) => n.props?.testID === 'connected-services-action:add-oauth-profile-browser')).toHaveLength(0);
  });

  it('renders embedded browser add method on native', async () => {
    vi.doMock('react-native', async () => {
      const actual = await vi.importActual<typeof import('react-native')>('react-native');
      return { ...actual, Platform: { ...actual.Platform, OS: 'ios' } };
    });

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceDetailView />);
    });

    expect(tree.root.findAll((n) => n.props?.testID === 'connected-services-action:add-oauth-profile-paste').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n) => n.props?.testID === 'connected-services-action:add-oauth-profile-browser').length).toBeGreaterThan(0);
  });
});
