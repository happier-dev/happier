import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    Platform: { ...actual.Platform, OS: 'ios' },
  };
});

let searchParams: Record<string, unknown> = { serviceId: 'anthropic', profileId: 'work' };
const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBackSpy, push: routerPushSpy }),
  useLocalSearchParams: () => searchParams,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
  getConnectedServiceRegistryEntry: (serviceId: string) => ({
    serviceId,
    connectCommand: `happier connect ${serviceId}`,
    supportsOauth: serviceId !== 'anthropic',
    oauthAddActionModes: serviceId === 'openai-codex'
      ? ['device', 'paste', 'browser']
      : serviceId === 'claude-subscription'
        ? ['paste']
        : ['paste'],
  }),
}));

vi.mock('@/sync/domains/connectedServices/oauth/connectedServiceOauthAdapters', () => ({
  getConnectedServiceOauthAdapter: (serviceId: string) => ({
    serviceId,
    defaultRedirectUri: 'http://localhost/cb',
    buildAuthorizationUrl: () => 'https://example.com/oauth',
    exchangeAuthorizationCodeForRecord: async () => ({}),
  }),
}));

vi.mock('@/components/ui/navigation/OAuthView', () => ({
  OAuthView: () => React.createElement('OAuthView'),
  OAuthViewUnsupported: () => React.createElement('OAuthViewUnsupported'),
}));

vi.mock('./oauth/ConnectedServiceOauthEmbeddedView', () => ({
  ConnectedServiceOauthEmbeddedView: (props: unknown) =>
    React.createElement('ConnectedServiceOauthEmbeddedView', props as Record<string, unknown>),
}));

vi.mock('./ConnectedServiceOauthPasteView', () => ({
  ConnectedServiceOauthPasteView: (props: unknown) => React.createElement('ConnectedServiceOauthPasteView', props as Record<string, unknown>),
}));

vi.mock('./oauth/openai/OpenAiCodexDeviceAuthView', () => ({
  OpenAiCodexDeviceAuthView: (props: unknown) => React.createElement('OpenAiCodexDeviceAuthView', props as Record<string, unknown>),
}));

describe('ConnectedServiceOauthView mode selection', () => {
  it('renders unsupported when the service does not support oauth', async () => {
    searchParams = { serviceId: 'anthropic', profileId: 'work' };
    routerPushSpy.mockClear();
    routerBackSpy.mockClear();
    const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceOauthView />);
    });

    expect(tree.root.findAllByType('OAuthViewUnsupported' as any)).toHaveLength(1);
    expect(tree.root.findAllByType('ConnectedServiceOauthPasteView' as any)).toHaveLength(0);
  });

  it('uses paste fallback for openai-codex device auth on native', async () => {
    searchParams = { serviceId: 'openai-codex', profileId: 'work' };
    routerPushSpy.mockClear();
    routerBackSpy.mockClear();

    const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceOauthView />);
    });

    const deviceViews = tree.root.findAllByType('OpenAiCodexDeviceAuthView' as any);
    expect(deviceViews).toHaveLength(1);
    expect(deviceViews[0]?.props?.fallbackAction?.onPress).toBeTypeOf('function');

    await act(async () => {
      deviceViews[0]?.props?.fallbackAction?.onPress?.();
    });

    expect(routerPushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ method: 'paste' }),
      }),
    );
  });

  it('supports embedded oauth for claude-subscription when explicitly requested on native', async () => {
    searchParams = { serviceId: 'claude-subscription', profileId: 'work', method: 'browser' };
    routerPushSpy.mockClear();
    routerBackSpy.mockClear();
    const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceOauthView />);
    });

    expect(tree.root.findAllByType('ConnectedServiceOauthEmbeddedView' as any)).toHaveLength(1);
    expect(tree.root.findAllByType('ConnectedServiceOauthPasteView' as any)).toHaveLength(0);
  });

  it('supports embedded oauth for openai-codex when explicitly requested on native', async () => {
    searchParams = { serviceId: 'openai-codex', profileId: 'work', method: 'browser' };
    routerPushSpy.mockClear();
    routerBackSpy.mockClear();
    const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceOauthView />);
    });

    expect(tree.root.findAllByType('ConnectedServiceOauthEmbeddedView' as any)).toHaveLength(1);
    expect(tree.root.findAllByType('OpenAiCodexDeviceAuthView' as any)).toHaveLength(0);
  });
});
