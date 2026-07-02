import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';

import { WelcomeDecisionPanel } from './WelcomeDecisionPanel';

const deviceState = vi.hoisted(() => ({
    width: 390,
    height: 844,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({
            width: deviceState.width,
            height: deviceState.height,
            scale: 3,
            fontScale: 1,
        }),
    });
});

const baseOptions: AuthEntryOptions = {
    serverAvailability: 'ready',
    serverUrlForCopy: 'https://relay.example.test',
    showAuthActions: true,
    showProviderSignup: false,
    showAnonymousSignup: true,
    showMtlsLogin: false,
    showKeylessProviderLogin: false,
    providerId: null,
    keylessProviderId: null,
    providerSignupTitle: '',
    providerKeylessTitle: '',
    anonymousSignupTitle: 'Create account',
    mtlsTitle: 'Sign in with certificate',
    primarySignupTitle: 'Create account',
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
};

function renderPanel() {
    return renderScreen(
        <WelcomeDecisionPanel
            authEntryOptions={baseOptions}
            onCreateAccount={vi.fn()}
            onCreateAccountViaProvider={vi.fn()}
            onLoginWithKeylessProvider={vi.fn()}
            onLoginWithMtls={vi.fn()}
            onOpenRestore={vi.fn()}
            onChangeRelay={vi.fn()}
        />,
    );
}

describe('WelcomeDecisionPanel mobile wordmark', () => {
    beforeEach(() => {
        standardCleanup();
        deviceState.width = 390;
        deviceState.height = 844;
    });

    it('renders the Happier wordmark when the mobile workflow has no brand pane', async () => {
        const screen = await renderPanel();

        expect(screen.findByTestId('welcome-mobile-wordmark')).toBeTruthy();
        expect(screen.findByTestId('brand-wordmark')).toBeTruthy();
    });

    it('does not duplicate the wordmark inside the desktop workflow pane', async () => {
        deviceState.width = 900;
        const screen = await renderPanel();

        expect(screen.findAllByTestId('welcome-mobile-wordmark')).toHaveLength(0);
    });
});
