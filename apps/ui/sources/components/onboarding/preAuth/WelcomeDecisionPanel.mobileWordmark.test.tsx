import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';

import { WorkflowPanel } from '../unauthShell/WorkflowPanel';
import { WelcomeDecisionPanel } from './WelcomeDecisionPanel';

vi.mock('../unauthShell/WelcomeFooterLinks', () => ({
    WelcomeFooterLinks: 'WelcomeFooterLinks',
}));

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

function renderPanel(variant: 'desktop' | 'mobile') {
    return renderScreen(
        <WorkflowPanel
            variant={variant}
            isWelcomeStep
            onOpenRelayCustomFlow={vi.fn()}
            transitionKey="welcome"
            transitionDirection="replace"
        >
            <WelcomeDecisionPanel
                authEntryOptions={baseOptions}
                onCreateAccount={vi.fn()}
                onCreateAccountViaProvider={vi.fn()}
                onLoginWithKeylessProvider={vi.fn()}
                onLoginWithMtls={vi.fn()}
                onOpenRestore={vi.fn()}
                onChangeRelay={vi.fn()}
            />
        </WorkflowPanel>,
    );
}

describe('WelcomeDecisionPanel mobile wordmark', () => {
    beforeEach(() => {
        standardCleanup();
    });

    it('renders the Happier wordmark when the mobile workflow has no brand pane', async () => {
        const screen = await renderPanel('mobile');

        expect(screen.findByTestId('welcome-mobile-wordmark')).toBeTruthy();
        expect(screen.findByTestId('brand-wordmark')).toBeTruthy();
    });

    it('does not duplicate the wordmark inside the desktop workflow pane', async () => {
        const screen = await renderPanel('desktop');

        expect(screen.findAllByTestId('welcome-mobile-wordmark')).toHaveLength(0);
    });
});
