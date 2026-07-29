import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoistedState = vi.hoisted(() => ({
    journeyActive: false,
}));

installRootLayoutRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            pathname: '/',
            segments: ['(app)'],
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
        const Stack = Object.assign(
            () => React.createElement('Stack'),
            { Screen: routerMock.Stack.Screen },
        );
        return {
            ...routerMock,
            Stack,
        };
    },
});


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

vi.mock('@/components/appShell/runtime/AuthenticatedAppRuntimeMounts', () => ({
    AuthenticatedAppRuntimeMounts: () => React.createElement('AuthenticatedAppRuntimeMounts'),
}));

vi.mock('@/components/onboarding/tour/state/journeySession', () => ({
    doesOnboardingJourneyOwnTransientDemoServer: (active: boolean) => active,
    useOnboardingJourneySessionActive: () => hoistedState.journeyActive,
}));

vi.mock('@/components/navigation/mobile/chrome/MainAppTabStateProvider', () => ({
    MainAppTabStateProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

afterEach(() => {
    hoistedState.journeyActive = false;
    vi.resetModules();
});

describe('RootLayout mobile bottom chrome wiring', () => {
    it('renders the mobile bottom chrome host after the stack so only its capsule wins pointer hit-testing', async () => {
        hoistedState.journeyActive = false;
        const RootLayout = (await import('@/app/(app)/_layout')).default;
        const screen = await renderScreen(<RootLayout />);

        const stack = screen.tree.findByType('Stack' as never);
        const mobileChrome = screen.tree.findByType('MobileBottomChromeHost' as never);
        screen.tree.findByType('AuthenticatedAppRuntimeMounts' as never);

        // The Stack mock is intentionally a leaf. If chrome regresses inside Stack,
        // it will not render and the findByType above fails rather than producing
        // the same misleading Stack → MobileBottomChromeHost preorder.
        expect(stack.findAllByType('MobileBottomChromeHost' as never)).toHaveLength(0);
        expect(screen.tree.findAll((node) => (
            String(node.type) === 'AuthenticatedAppRuntimeMounts'
            || String(node.type) === 'Stack'
            || node === mobileChrome
        )).map((node) => String(node.type))).toEqual([
            'AuthenticatedAppRuntimeMounts',
            'Stack',
            'MobileBottomChromeHost',
        ]);
    });

    it('keeps app-only auxiliary mounts out of the full-viewport onboarding journey', async () => {
        hoistedState.journeyActive = true;
        const RootLayout = (await import('@/app/(app)/_layout')).default;
        const screen = await renderScreen(<RootLayout />);

        expect(screen.tree.findAllByType('MobileBottomChromeHost' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('AuthenticatedAppRuntimeMounts' as never)).toHaveLength(0);
    });
});
