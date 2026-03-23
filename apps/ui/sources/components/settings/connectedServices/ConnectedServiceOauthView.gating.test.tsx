import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installConnectedServicesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
        });
    },
    searchParams: { serviceId: 'openai-codex', profileId: 'work' },
});

const useFeatureEnabledSpy = vi.fn((_featureId: string) => false);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/components/ui/navigation/OAuthView', () => ({
  OAuthView: () => React.createElement('OAuthView'),
  OAuthViewUnsupported: (props: unknown) => React.createElement('OAuthViewUnsupported', props as Record<string, unknown>),
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
  getConnectedServiceRegistryEntry: (_serviceId: string) => ({ serviceId: 'openai-codex', connectCommand: 'happier connect codex', supportsOauth: true }),
}));

describe('ConnectedServiceOauthView gating', () => {
  it('does not expose native OAuth flow when connected services are disabled', async () => {
    useFeatureEnabledSpy.mockImplementation((featureId: string) => featureId !== 'connectedServices');
    const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceOauthView />)).tree;

    expect(tree.findAllByType('OAuthViewUnsupported' as any).length).toBeGreaterThan(0);
    expect(tree.findAllByType('OAuthView' as any)).toHaveLength(0);
  });
});
