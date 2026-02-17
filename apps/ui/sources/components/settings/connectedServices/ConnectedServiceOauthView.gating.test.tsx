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

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useLocalSearchParams: () => ({ serviceId: 'openai-codex', profileId: 'work' }),
}));

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
  getConnectedServiceRegistryEntry: (_serviceId: string) => ({ displayName: 'Codex', connectCommand: 'happier connect codex' }),
}));

describe('ConnectedServiceOauthView gating', () => {
  it('does not expose native OAuth flow when connected services are disabled', async () => {
    useFeatureEnabledSpy.mockImplementation((featureId: string) => featureId !== 'connectedServices');
    const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceOauthView />);
    });

    expect(tree.root.findAllByType('OAuthViewUnsupported' as any).length).toBeGreaterThan(0);
    expect(tree.root.findAllByType('OAuthView' as any)).toHaveLength(0);
  });
});
