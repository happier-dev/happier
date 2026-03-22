import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
  routerReplaceSpy: vi.fn(),
  searchParams: { id: 'session-1', messageId: 'message-1' } as { id?: string; messageId?: string; jumpChildId?: string },
}));

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const routerMock = createExpoRouterMock({
    params: shared.searchParams,
    router: {
      push: vi.fn(),
      back: vi.fn(),
      replace: shared.routerReplaceSpy,
      setParams: vi.fn(),
    },
  });

  return {
    ...routerMock.module,
    useLocalSearchParams: () => shared.searchParams,
    useGlobalSearchParams: () => shared.searchParams,
  };
});

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
    shared.routerReplaceSpy.mockClear();
    shared.searchParams = { id: 'session-1', messageId: 'message-1' };

    const { default: Screen } = await import('@/app/(app)/index');
    let tree: renderer.ReactTestRenderer | null = null;

    try {
      tree = (await renderScreen(<Screen />)).tree;
      await flushHookEffects();

      expect(shared.routerReplaceSpy).toHaveBeenCalledWith('/session/session-1/message/message-1');
    } finally {
      act(() => {
        tree?.unmount();
      });
    }
  });

  it('does not collapse a non-root web deep link to the session root', async () => {
    vi.resetModules();
    shared.routerReplaceSpy.mockClear();
    shared.searchParams = { id: 'session-1' };

    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          pathname: '/session/session-1/message/message-1',
        },
      },
    });

    try {
      const { default: Screen } = await import('@/app/(app)/index');
      let tree: renderer.ReactTestRenderer | null = null;

      try {
        tree = (await renderScreen(<Screen />)).tree;
        await flushHookEffects();

        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
      } finally {
        act(() => {
          tree?.unmount();
        });
      }
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});
