import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { AuthEntryView } from './AuthEntryView';

describe('AuthEntryView', () => {
    it('renders a retry action when the server is unavailable', async () => {
        const onChangeRelay = vi.fn();
        const retryServerCheck = vi.fn();

        const screen = await renderScreen(
            <AuthEntryView
                layout="portrait"
                isDesktopShell={false}
                options={{
                    serverAvailability: 'unavailable',
                    serverUrlForCopy: 'https://relay.example.test',
                    showAuthActions: false,
                    showProviderSignup: false,
                    showAnonymousSignup: false,
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
                    retryServerCheck,
                }}
                onOpenSetup={vi.fn()}
                onChangeRelay={onChangeRelay}
                onRestore={vi.fn()}
                onCreateAccount={vi.fn()}
                onCreateAccountViaProvider={vi.fn()}
                onLoginWithKeylessProvider={vi.fn()}
                onLoginWithMtls={vi.fn()}
            />,
        );

        expect(screen.findByTestId('welcome-server-unavailable')).toBeTruthy();
        expect(screen.findByTestId('welcome-configure-server')).toBeTruthy();
        expect(screen.findByTestId('welcome-retry-server')).toBeTruthy();

        await act(async () => {
            await screen.findByTestId('welcome-retry-server')!.props.onPress?.();
        });
        expect(retryServerCheck).toHaveBeenCalled();

        await act(async () => {
            await screen.findByTestId('welcome-configure-server')!.props.onPress?.();
        });
        expect(onChangeRelay).toHaveBeenCalled();
    });

    it('invokes create account from the ready welcome screen', async () => {
        const onCreateAccount = vi.fn();

        const screen = await renderScreen(
            <AuthEntryView
                layout="portrait"
                isDesktopShell={false}
                options={{
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
                    retryServerCheck: vi.fn(),
                }}
                onOpenSetup={vi.fn()}
                onChangeRelay={vi.fn()}
                onRestore={vi.fn()}
                onCreateAccount={onCreateAccount}
                onCreateAccountViaProvider={vi.fn()}
                onLoginWithKeylessProvider={vi.fn()}
                onLoginWithMtls={vi.fn()}
            />,
        );

        await act(async () => {
            await screen.findByTestId('welcome-create-account')!.props.onPress?.();
        });

        expect(onCreateAccount).toHaveBeenCalled();
    });

    it('keeps a secondary keyless provider login action when anonymous signup stays primary', async () => {
        const onCreateAccount = vi.fn();
        const onLoginWithKeylessProvider = vi.fn();

        const screen = await renderScreen(
            <AuthEntryView
                layout="portrait"
                isDesktopShell={false}
                options={{
                    serverAvailability: 'ready',
                    serverUrlForCopy: 'https://relay.example.test',
                    showAuthActions: true,
                    showProviderSignup: false,
                    showAnonymousSignup: true,
                    showMtlsLogin: false,
                    showKeylessProviderLogin: true,
                    providerId: null,
                    keylessProviderId: 'github',
                    providerSignupTitle: '',
                    providerKeylessTitle: 'Continue with GitHub',
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
                    retryServerCheck: vi.fn(),
                }}
                onOpenSetup={vi.fn()}
                onChangeRelay={vi.fn()}
                onRestore={vi.fn()}
                onCreateAccount={onCreateAccount}
                onCreateAccountViaProvider={vi.fn()}
                onLoginWithKeylessProvider={onLoginWithKeylessProvider}
                onLoginWithMtls={vi.fn()}
            />,
        );

        expect(screen.findByTestId('welcome-create-account')).toBeTruthy();
        expect(screen.findByTestId('welcome-login-provider')).toBeTruthy();

        await act(async () => {
            await screen.findByTestId('welcome-login-provider')!.props.onPress?.();
        });

        expect(onCreateAccount).not.toHaveBeenCalled();
        expect(onLoginWithKeylessProvider).toHaveBeenCalledWith('github');
    });
});
