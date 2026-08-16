import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import {
    deriveRemoteAuthEntryOptions,
    type RemoteAuthEntryOptionsInput,
} from './useRemoteAuthEntryOptions';
import { RemoteWelcomeDecisionPanel } from './RemoteWelcomeDecisionPanel';
import { lightTheme } from '@/theme';

const noop = () => {};

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function createInput(overrides: Partial<RemoteAuthEntryOptionsInput> = {}): RemoteAuthEntryOptionsInput {
    return {
        serverAvailability: 'ready',
        serverUrlForCopy: 'https://relay.example.test',
        retryServerCheck: noop,
        signupOptions: {
            anonymousEnabled: true,
            providerIds: Object.freeze([]),
            preferredProviderId: null,
        },
        loginOptions: {
            mtlsEnabled: false,
            keylessProviderIds: Object.freeze([]),
            preferredKeylessProviderId: null,
        },
        providerDisplayNameById: (providerId) => (providerId === 'github' ? 'GitHub' : providerId),
        hasPendingTerminalConnect: false,
        hasPendingSetupIntent: false,
        ...overrides,
    };
}

describe('deriveRemoteAuthEntryOptions', () => {
    it('maps anonymous signup availability to the anonymous primary action kind', () => {
        const options = deriveRemoteAuthEntryOptions(createInput());

        expect(options.primaryAction).toMatchObject({ kind: 'anonymous' });
        expect(options.showAnonymousSignup).toBe(true);
        expect(options.showProviderSignup).toBe(false);
        expect(options.providerId).toBeNull();
    });

    it('maps provider-only signup to provider-keyed without exposing anonymous signup', () => {
        const options = deriveRemoteAuthEntryOptions(
            createInput({
                signupOptions: {
                    anonymousEnabled: false,
                    providerIds: Object.freeze(['github']),
                    preferredProviderId: 'github',
                },
            }),
        );

        expect(options.primaryAction).toMatchObject({ kind: 'provider-keyed' });
        expect(options.showAnonymousSignup).toBe(false);
        expect(options.showProviderSignup).toBe(true);
        expect(options.providerId).toBe('github');
    });

    it('maps mTLS-only login to the mTLS primary action kind', () => {
        const options = deriveRemoteAuthEntryOptions(
            createInput({
                signupOptions: {
                    anonymousEnabled: false,
                    providerIds: Object.freeze([]),
                    preferredProviderId: null,
                },
                loginOptions: {
                    mtlsEnabled: true,
                    keylessProviderIds: Object.freeze([]),
                    preferredKeylessProviderId: null,
                },
            }),
        );

        expect(options.primaryAction).toMatchObject({ kind: 'mtls' });
        expect(options.showMtlsLogin).toBe(true);
        expect(options.mtlsPrimary).toBe(true);
    });

    it('maps keyless provider-only login to the keyless primary action kind', () => {
        const options = deriveRemoteAuthEntryOptions(
            createInput({
                signupOptions: {
                    anonymousEnabled: false,
                    providerIds: Object.freeze([]),
                    preferredProviderId: null,
                },
                loginOptions: {
                    mtlsEnabled: false,
                    keylessProviderIds: Object.freeze(['github']),
                    preferredKeylessProviderId: 'github',
                },
            }),
        );

        expect(options.primaryAction).toMatchObject({ kind: 'keyless' });
        expect(options.showKeylessProviderLogin).toBe(true);
        expect(options.keylessProviderId).toBe('github');
        expect(options.keylessPrimary).toBe(true);
    });

    it('represents disabled signup as an explicit empty primary action', () => {
        const options = deriveRemoteAuthEntryOptions(
            createInput({
                signupOptions: {
                    anonymousEnabled: false,
                    providerIds: Object.freeze([]),
                    preferredProviderId: null,
                },
            }),
        );

        expect(options.primaryAction).toBeNull();
        expect(options.showAnonymousSignup).toBe(false);
        expect(options.showProviderSignup).toBe(false);
    });
});

describe('RemoteWelcomeDecisionPanel', () => {
    afterEach(standardCleanup);

    it('renders the first-time question copy for anonymous signup', async () => {
        const screen = await renderScreen(
            <RemoteWelcomeDecisionPanel
                options={deriveRemoteAuthEntryOptions(createInput())}
                isDesktopShell={false}
                layout="portrait"
                onAnonymousSignup={noop}
                onChangeRelay={noop}
                onKeylessProviderLogin={noop}
                onMtlsLogin={noop}
                onOpenSetup={noop}
                onProviderSignup={noop}
                onRestore={noop}
            />,
        );

        expect(screen.findByTestId('welcome-question-title')).toBeTruthy();
        expect(screen.findByTestId('welcome-question-subtitle')).toBeTruthy();
        expect(screen.findByTestId('welcome-private-key-copy')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start-title')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start-subtitle')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start-icon')).toBeTruthy();
        expect(screen.findByTestId('welcome-secondary-login-title')).toBeTruthy();
        expect(screen.findByTestId('welcome-secondary-login-subtitle')).toBeTruthy();
        expect(screen.findByTestId('welcome-secondary-login-icon')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start-title')?.props.children).toBe('First time here — let\'s start');
        expect(screen.findByTestId('welcome-secondary-login-subtitle')?.props.children).toBe('Scan a QR code, or enter your secret key');
        const primaryStyle = flattenStyle(screen.findByTestId('welcome-primary-start')?.props.style);
        const textBlockStyle = flattenStyle(screen.findByTestId('welcome-primary-start-text')?.props.style);
        expect(primaryStyle.minHeight).toBe(66);
        expect(primaryStyle.paddingHorizontal).toBe(18);
        expect(primaryStyle.paddingVertical).toBe(10);
        expect(primaryStyle.backgroundColor).toBe(lightTheme.colors.button.primary.background);
        expect(primaryStyle.borderColor).toBe(lightTheme.colors.button.primary.background);
        expect(textBlockStyle.gap).toBe(0);
        const primaryTitleStyle = flattenStyle(screen.findByTestId('welcome-primary-start-title')?.props.style);
        const primarySubtitleStyle = flattenStyle(screen.findByTestId('welcome-primary-start-subtitle')?.props.style);
        expect(primaryTitleStyle.color).toBe(lightTheme.colors.button.primary.tint);
        expect(primarySubtitleStyle.color).toBe(lightTheme.colors.button.primary.tint);
    });

    it('explains disabled signup while keeping login as the primary recovery action', async () => {
        const options = deriveRemoteAuthEntryOptions(
            createInput({
                signupOptions: {
                    anonymousEnabled: false,
                    providerIds: Object.freeze([]),
                    preferredProviderId: null,
                },
            }),
        );
        const screen = await renderScreen(
            <RemoteWelcomeDecisionPanel
                options={options}
                isDesktopShell={false}
                layout="portrait"
                onAnonymousSignup={noop}
                onChangeRelay={noop}
                onKeylessProviderLogin={noop}
                onMtlsLogin={noop}
                onOpenSetup={noop}
                onProviderSignup={noop}
                onRestore={noop}
            />,
        );

        expect(screen.findByTestId('welcome-signup-disabled')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(flattenStyle(screen.findByTestId('welcome-secondary-login')?.props.style).backgroundColor)
            .toBe(lightTheme.colors.button.primary.background);
    });

    it('routes the restore action through the supplied login callback', async () => {
        const onRestore = vi.fn();
        const screen = await renderScreen(
            <RemoteWelcomeDecisionPanel
                options={deriveRemoteAuthEntryOptions(createInput())}
                isDesktopShell={false}
                layout="portrait"
                onAnonymousSignup={noop}
                onChangeRelay={noop}
                onKeylessProviderLogin={noop}
                onMtlsLogin={noop}
                onOpenSetup={noop}
                onProviderSignup={noop}
                onRestore={onRestore}
            />,
        );

        await screen.pressByTestIdAsync('welcome-secondary-login');

        expect(onRestore).toHaveBeenCalledTimes(1);
    });

    it('routes anonymous signup from the visual primary decision row', async () => {
        const onAnonymousSignup = vi.fn();
        const screen = await renderScreen(
            <RemoteWelcomeDecisionPanel
                options={deriveRemoteAuthEntryOptions(createInput())}
                isDesktopShell={false}
                layout="portrait"
                onAnonymousSignup={onAnonymousSignup}
                onChangeRelay={noop}
                onKeylessProviderLogin={noop}
                onMtlsLogin={noop}
                onOpenSetup={noop}
                onProviderSignup={noop}
                onRestore={noop}
            />,
        );

        await screen.pressByTestIdAsync('welcome-primary-start');

        expect(onAnonymousSignup).toHaveBeenCalledTimes(1);
    });

    it('keeps unavailable-server retry and relay-change actions available', async () => {
        const onChangeRelay = vi.fn();
        const retryServerCheck = vi.fn();
        const screen = await renderScreen(
            <RemoteWelcomeDecisionPanel
                options={deriveRemoteAuthEntryOptions(createInput({ serverAvailability: 'unavailable', retryServerCheck }))}
                isDesktopShell={false}
                layout="portrait"
                onAnonymousSignup={noop}
                onChangeRelay={onChangeRelay}
                onKeylessProviderLogin={noop}
                onMtlsLogin={noop}
                onOpenSetup={noop}
                onProviderSignup={noop}
                onRestore={noop}
            />,
        );

        const titleStyle = flattenStyle(screen.findByTestId('welcome-server-unavailable-title')?.props.style);
        expect(titleStyle.fontSize).toBeGreaterThanOrEqual(22);

        await screen.pressByTestIdAsync('welcome-change-relay');
        await screen.pressByTestIdAsync('welcome-retry-server');

        expect(onChangeRelay).toHaveBeenCalledTimes(1);
        expect(retryServerCheck).toHaveBeenCalledTimes(1);
    });

    it('routes provider-only signup through the provider callback', async () => {
        const onProviderSignup = vi.fn();
        const screen = await renderScreen(
            <RemoteWelcomeDecisionPanel
                options={deriveRemoteAuthEntryOptions(createInput({
                    signupOptions: {
                        anonymousEnabled: false,
                        providerIds: Object.freeze(['github']),
                        preferredProviderId: 'github',
                    },
                }))}
                isDesktopShell={false}
                layout="portrait"
                onAnonymousSignup={noop}
                onChangeRelay={noop}
                onKeylessProviderLogin={noop}
                onMtlsLogin={noop}
                onOpenSetup={noop}
                onProviderSignup={onProviderSignup}
                onRestore={noop}
            />,
        );

        await screen.pressByTestIdAsync('welcome-signup-provider');

        expect(screen.findAllByTestId('welcome-create-account')).toHaveLength(0);
        expect(onProviderSignup).toHaveBeenCalledWith('github');
    });

    it('routes mTLS-primary login through the certificate callback', async () => {
        const onMtlsLogin = vi.fn();
        const screen = await renderScreen(
            <RemoteWelcomeDecisionPanel
                options={deriveRemoteAuthEntryOptions(createInput({
                    signupOptions: {
                        anonymousEnabled: false,
                        providerIds: Object.freeze([]),
                        preferredProviderId: null,
                    },
                    loginOptions: {
                        mtlsEnabled: true,
                        keylessProviderIds: Object.freeze([]),
                        preferredKeylessProviderId: null,
                    },
                }))}
                isDesktopShell={false}
                layout="portrait"
                onAnonymousSignup={noop}
                onChangeRelay={noop}
                onKeylessProviderLogin={noop}
                onMtlsLogin={onMtlsLogin}
                onOpenSetup={noop}
                onProviderSignup={noop}
                onRestore={noop}
            />,
        );

        await screen.pressByTestIdAsync('welcome-create-account');

        expect(screen.findAllByTestId('welcome-signup-provider')).toHaveLength(0);
        expect(onMtlsLogin).toHaveBeenCalledTimes(1);
    });

    it('routes keyless-primary login through the keyless provider callback', async () => {
        const onKeylessProviderLogin = vi.fn();
        const screen = await renderScreen(
            <RemoteWelcomeDecisionPanel
                options={deriveRemoteAuthEntryOptions(createInput({
                    signupOptions: {
                        anonymousEnabled: false,
                        providerIds: Object.freeze([]),
                        preferredProviderId: null,
                    },
                    loginOptions: {
                        mtlsEnabled: false,
                        keylessProviderIds: Object.freeze(['github']),
                        preferredKeylessProviderId: 'github',
                    },
                }))}
                isDesktopShell={false}
                layout="portrait"
                onAnonymousSignup={noop}
                onChangeRelay={noop}
                onKeylessProviderLogin={onKeylessProviderLogin}
                onMtlsLogin={noop}
                onOpenSetup={noop}
                onProviderSignup={noop}
                onRestore={noop}
            />,
        );

        await screen.pressByTestIdAsync('welcome-create-account');

        expect(screen.findAllByTestId('welcome-signup-provider')).toHaveLength(0);
        expect(onKeylessProviderLogin).toHaveBeenCalledWith('github');
    });

    it('keeps a visible secondary keyless provider login when anonymous signup remains primary', async () => {
        const onKeylessProviderLogin = vi.fn();
        const screen = await renderScreen(
            <RemoteWelcomeDecisionPanel
                options={deriveRemoteAuthEntryOptions(createInput({
                    signupOptions: {
                        anonymousEnabled: true,
                        providerIds: Object.freeze([]),
                        preferredProviderId: null,
                    },
                    loginOptions: {
                        mtlsEnabled: false,
                        keylessProviderIds: Object.freeze(['github']),
                        preferredKeylessProviderId: 'github',
                    },
                }))}
                isDesktopShell={false}
                layout="portrait"
                onAnonymousSignup={noop}
                onChangeRelay={noop}
                onKeylessProviderLogin={onKeylessProviderLogin}
                onMtlsLogin={noop}
                onOpenSetup={noop}
                onProviderSignup={noop}
                onRestore={noop}
            />,
        );

        expect(screen.findByTestId('welcome-login-provider')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-login-provider');

        expect(onKeylessProviderLogin).toHaveBeenCalledWith('github');
    });
});
