import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installRootLayoutRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/',
            segments: ['(app)'],
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        refreshFromActiveServer: vi.fn(async () => {}),
    }),
}));

vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => false,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: true }),
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => true,
}));

vi.mock('@/components/navigation/mobile/chrome/MobileBottomChromeHost', () => ({
    MobileBottomChromeHost: () => React.createElement('MobileBottomChromeHost'),
}));

vi.mock('@/components/navigation/mobile/chrome/MainAppTabStateProvider', () => ({
    MainAppTabStateProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

afterEach(() => {
    vi.resetModules();
});

describe('RootLayout mobile bottom chrome wiring', () => {
    it('renders the mobile bottom chrome host under the stack', async () => {
        const RootLayout = (await import('@/app/(app)/_layout')).default;
        const screen = await renderScreen(<RootLayout />);

        expect(screen.tree.findAllByType('MobileBottomChromeHost' as never)).toHaveLength(1);
    });
});
