import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceSpy = vi.fn();

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: routerReplaceSpy }),
  router: { replace: routerReplaceSpy },
  useLocalSearchParams: () => ({ id: 'session-1', messageId: 'message-1' }),
}));

vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));
vi.mock('@shopify/react-native-skia', () => ({}));
vi.mock('@/components/navigation/shell/HomeHeader', () => ({ HomeHeaderNotAuth: () => null }));
vi.mock('@/components/navigation/shell/MainView', () => ({ MainView: () => null }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    credentials: { token: 't', secret: new Uint8Array([1]) },
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
  }),
}));

vi.mock('@/encryption/libsodium.lib', () => ({ default: {} }));

describe('/ authenticated deep link redirects', () => {
  it('redirects to /session/:id/message/:messageId when query params are present', async () => {
    vi.resetModules();
    routerReplaceSpy.mockClear();

    const { default: Screen } = await import('@/app/(app)/index');

    await act(async () => {
      renderer.create(<Screen />);
    });
    await act(async () => {});

    expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1/message/message-1');
  });
});
