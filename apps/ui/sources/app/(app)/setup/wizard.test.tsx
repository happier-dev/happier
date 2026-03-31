import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

const expoRouterMock = vi.hoisted(() => {
    const replace = vi.fn();
    const router = { replace };
    return {
        spies: { replace },
        module: {
            router,
            useRouter: () => router,
            useNavigation: () => null,
            useSegments: () => [],
            usePathname: () => '/',
            useLocalSearchParams: () => ({}),
            useGlobalSearchParams: () => ({}),
            Stack: Object.assign(
                function Stack(props: { children?: React.ReactNode }) {
                    return React.createElement(React.Fragment, null, props.children ?? null);
                },
                {
                    Screen: (props: Record<string, unknown>) => React.createElement('StackScreen', props),
                },
            ),
            Link: 'Link' as any,
            Redirect: (props: Record<string, unknown>) => React.createElement('Redirect', props),
        },
    };
});

vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));
vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: Record<string, unknown>) => React.createElement('BaseModal', props, props.children as any),
}));
vi.mock('@/components/onboardingWizard/SetupWizardSurface', () => ({
    SetupWizardSurface: (props: Record<string, unknown>) => React.createElement('SetupWizardSurface', props),
}));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    clearPendingSetupIntent: vi.fn(),
}));

describe('SetupWizardRoute', () => {
    beforeEach(() => {
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));
        expoRouterMock.spies.replace.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('returns to home when dismissed', async () => {
        const Route = (await import('./wizard')).default;
        const screen = await renderScreen(<Route />);

        const surface = screen.findByType('SetupWizardSurface' as any);
        surface.props.onExit();

        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('opens the setup wizard inside a scrollable full-screen modal on web', async () => {
        const Route = (await import('./wizard')).default;
        const screen = await renderScreen(<Route />);

        const modal = screen.findByType('BaseModal' as any);
        const surface = screen.findByType('SetupWizardSurface' as any);
        expect(surface.props.useOuterScrollContainer).toBe(true);
        expect(modal.props.scrollable).toBe(true);
        expect(modal.props.disableContentTransform).toBe(true);
        expect(modal.props.showBackdrop).toBe(false);
    });
});
