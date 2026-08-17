import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';

import { WelcomeDecisionPanel } from './WelcomeDecisionPanel';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
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
    primaryAction: {
        kind: 'anonymous',
        title: 'Create account',
    },
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

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        const resolvePressableStyle = style as (state: { pressed: boolean }) => unknown;
        return flattenStyle(resolvePressableStyle({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function renderPanel(overrides: Partial<AuthEntryOptions> = {}) {
    const callbacks = {
        onCreateAccount: vi.fn(),
        onCreateAccountViaProvider: vi.fn(),
        onLoginWithKeylessProvider: vi.fn(),
        onLoginWithMtls: vi.fn(),
        onOpenRestore: vi.fn(),
        onChangeRelay: vi.fn(),
    };

    return {
        callbacks,
        screenPromise: renderScreen(
            <WelcomeDecisionPanel
                authEntryOptions={{ ...baseOptions, ...overrides }}
                {...callbacks}
            />,
        ),
    };
}

describe('WelcomeDecisionPanel', () => {
    it('routes anonymous start and restore actions from stable controls', async () => {
        const { callbacks, screenPromise } = renderPanel();
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
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
        expect(textBlockStyle.gap).toBe(0);

        await screen.pressByTestIdAsync('welcome-primary-start');
        await screen.pressByTestIdAsync('welcome-secondary-login');

        expect(callbacks.onCreateAccount).toHaveBeenCalledTimes(1);
        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
    });

    it('uses provider signup without rendering anonymous private-key copy', async () => {
        const { callbacks, screenPromise } = renderPanel({
            showAnonymousSignup: false,
            showProviderSignup: true,
            providerId: 'github',
            providerSignupTitle: 'Continue with GitHub',
            primaryAction: {
                kind: 'provider-keyed',
                title: 'Continue with GitHub',
            },
        });
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);

        await screen.pressByTestIdAsync('welcome-provider-primary');

        expect(callbacks.onCreateAccountViaProvider).toHaveBeenCalledWith('github');
    });

    it('uses keyless provider login without rendering anonymous private-key copy', async () => {
        const { callbacks, screenPromise } = renderPanel({
            showAnonymousSignup: false,
            showKeylessProviderLogin: true,
            keylessPrimary: true,
            keylessProviderId: 'github',
            providerKeylessTitle: 'Continue with GitHub',
            primaryAction: {
                kind: 'keyless',
                title: 'Continue with GitHub',
            },
        });
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);

        await screen.pressByTestIdAsync('welcome-provider-primary');

        expect(callbacks.onLoginWithKeylessProvider).toHaveBeenCalledWith('github');
    });

    it('keeps a visible secondary keyless provider login when anonymous signup remains primary', async () => {
        const { callbacks, screenPromise } = renderPanel({
            showAnonymousSignup: true,
            showKeylessProviderLogin: true,
            keylessPrimary: false,
            keylessProviderId: 'github',
            providerKeylessTitle: 'Continue with GitHub',
            primaryAction: {
                kind: 'anonymous',
                title: 'Create account',
            },
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
        expect(screen.findByTestId('welcome-login-provider')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-login-provider');

        expect(callbacks.onLoginWithKeylessProvider).toHaveBeenCalledWith('github');
    });

    it('uses mTLS login without rendering anonymous private-key copy', async () => {
        const { callbacks, screenPromise } = renderPanel({
            showAnonymousSignup: false,
            showMtlsLogin: true,
            mtlsPrimary: true,
            primaryAction: {
                kind: 'mtls',
                title: 'Sign in with certificate',
            },
        });
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);

        await screen.pressByTestIdAsync('welcome-mtls-primary');

        expect(callbacks.onLoginWithMtls).toHaveBeenCalledTimes(1);
    });

    it('shows loading state without auth actions before capabilities resolve', async () => {
        const { screenPromise } = renderPanel({
            serverAvailability: 'loading',
            showAuthActions: false,
            showAnonymousSignup: false,
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-auth-loading')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-secondary-login')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);
    });

    it('keeps retry and relay-change actions available when the server is unavailable', async () => {
        const retryServerCheck = vi.fn();
        const { callbacks, screenPromise } = renderPanel({
            serverAvailability: 'unavailable',
            showAuthActions: false,
            showAnonymousSignup: false,
            retryServerCheck,
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-auth-blocked')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);

        await screen.pressByTestIdAsync('welcome-auth-blocked-change-relay');
        await screen.pressByTestIdAsync('welcome-auth-blocked-retry');

        expect(callbacks.onChangeRelay).toHaveBeenCalledTimes(1);
        expect(retryServerCheck).toHaveBeenCalledTimes(1);
    });

    it('promotes login and explains the policy when the server exposes no signup action', async () => {
        const { callbacks, screenPromise } = renderPanel({
            showAnonymousSignup: false,
            showProviderSignup: false,
            primaryAction: null,
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-signup-disabled')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-provider-primary')).toHaveLength(0);
        expect(screen.findByTestId('welcome-secondary-login')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-secondary-login');

        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
        expect(callbacks.onCreateAccount).not.toHaveBeenCalled();
    });
});
