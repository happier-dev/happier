import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pushSpy = vi.fn();
const applySettingsSpy = vi.fn(async () => {});

installConnectedServicesCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { back: vi.fn(), push: pushSpy },
            params: { serviceId: 'claude-subscription' },
        });
        return routerMock.module;
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } }),
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

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
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
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        const screen = await renderScreen(<ConnectedServiceDetailView />);

    expect(screen.findByTestId('connected-services-action:add-oauth-profile-paste')).toBeTruthy();
    expect(screen.findByTestId('connected-services-action:add-oauth-profile-browser')).toBeNull();
    });

    it('renders embedded browser add method on native', async () => {
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'ios' } }));

        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        const screen = await renderScreen(<ConnectedServiceDetailView />);

    expect(screen.findByTestId('connected-services-action:add-oauth-profile-paste')).toBeTruthy();
    expect(screen.findByTestId('connected-services-action:add-oauth-profile-browser')).toBeTruthy();
  });
});
