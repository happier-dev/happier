import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const reactNativeState = vi.hoisted(() => ({
    windowWidth: 390,
    windowHeight: 844,
}));

const routerMocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({
            width: reactNativeState.windowWidth,
            height: reactNativeState.windowHeight,
            scale: 2,
            fontScale: 1,
        }),
    });
});

vi.mock('expo-router', () => ({
    useRouter: () => ({
        push: routerMocks.push,
        replace: routerMocks.replace,
        back: routerMocks.back,
    }),
}));

vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: any) => React.createElement('BaseModal', props, props.children),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: false,
        login: vi.fn(),
        loginWithCredentials: vi.fn(),
    }),
}));

vi.mock('@/components/account/auth/useAuthEntryOptions', () => ({
    useAuthEntryOptions: () => ({
        serverAvailability: 'ready',
        serverUrlForCopy: 'https://relay.example.test',
        showAuthActions: true,
        showProviderSignup: false,
        showAnonymousSignup: false,
        showMtlsLogin: false,
        showKeylessProviderLogin: false,
        providerId: null,
        keylessProviderId: null,
        providerSignupTitle: '',
        providerKeylessTitle: '',
        anonymousSignupTitle: '',
        mtlsTitle: '',
        primarySignupTitle: '',
        mtlsPrimary: false,
        keylessPrimary: false,
        autoRedirect: {
            enabled: false,
            providerId: null,
            toKeyedProvision: false,
            toKeylessLogin: false,
            toMtls: false,
            toLegacySignupProvider: false,
        },
        retryServerCheck: () => {},
    }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsLandscape: () => false,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => null,
    clearPendingSetupIntent: () => {},
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverUrl: null,
    }),
}));

vi.mock('@/sync/domains/server/readConfiguredServerUrlEnv', () => ({
    readConfiguredServerUrlEnv: () => '',
}));

vi.mock('@/components/onboarding/surfaces/OnboardingWizardSurface', () => ({
    OnboardingWizardSurface: (props: Record<string, unknown>) => React.createElement('OnboardingWizardSurface', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('PreAuthOnboardingWizardEntry', () => {
    const originalDebug = process.env.EXPO_PUBLIC_DEBUG;

    beforeEach(() => {
        process.env.EXPO_PUBLIC_DEBUG = '1';
        reactNativeState.windowWidth = 390;
        reactNativeState.windowHeight = 844;
        routerMocks.push.mockReset();
        routerMocks.replace.mockReset();
        routerMocks.back.mockReset();
        if (typeof window !== 'undefined') {
            window.history.pushState({}, '', '/?happier_wizard_step=relay_select');
        } else {
            (globalThis as unknown as { location?: { search?: string } }).location = {
                search: '?happier_wizard_step=relay_select',
            };
        }
    });

    afterEach(() => {
        process.env.EXPO_PUBLIC_DEBUG = originalDebug;
        standardCleanup();
    });

    it('passes a debug initialStepId from happier_wizard_step in debug builds', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const wizard = screen.findByType('OnboardingWizardSurface' as never);
        expect(wizard.props.initialStepId).toBe('relay_select');
    });

    it('wraps the onboarding wizard in a top-aligned BaseModal on narrow web so the wizard can use fullscreen presentation', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const modal = screen.findByType('BaseModal' as never);
        expect(modal.props.showBackdrop).toBe(true);
        expect(modal.props.webPlacement).toBe('top');
    });

    it('routes the change-relay action to the wizard relay selection step', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const wizard = screen.findByType('OnboardingWizardSurface' as never);
        await wizard.props.onChangeRelayViaServerConfig?.();

        expect(routerMocks.replace).toHaveBeenCalledWith('/?happier_wizard_step=relay_select');
    });
});
