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
        installReactNativeWebMock();
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
});

