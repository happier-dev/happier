import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

vi.mock('react-native', installReactNativeWebMock());

vi.mock('expo-router', () => ({
    useRouter: () => ({
        push: vi.fn(),
        replace: vi.fn(),
        back: vi.fn(),
    }),
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

vi.mock('@/components/onboardingWizard/OnboardingWizardSurface', () => ({
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
        if (typeof window !== 'undefined') {
            window.history.pushState({}, '', '/?happier_wizard_step=relay_select');
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
});

