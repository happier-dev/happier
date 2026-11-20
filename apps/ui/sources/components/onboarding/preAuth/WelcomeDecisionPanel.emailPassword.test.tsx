import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { t } from '@/text';

import { WelcomeDecisionPanel } from './WelcomeDecisionPanel';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

const EMAIL_PASSWORD_METHOD = {
    id: 'email_password',
    enabledActions: [
        { id: 'login' as const, mode: 'either' as const },
        { id: 'provision' as const, mode: 'either' as const },
    ],
    // The Home projects a server-authored English display name for every method.
    // A built-in native method must not render it as if it were an OAuth badge.
    presentation: { displayName: 'Email Password' },
};

const baseOptions: AuthEntryOptions = {
    homeTarget: { kind: 'saved_profile', profileRef: 'home-a' },
    requestedHomeTarget: { kind: 'saved_profile', profileRef: 'home-a' },
    homeLabel: 'Home A',
    authenticationActions: [
        {
            method: { id: 'key_challenge', enabledActions: [{ id: 'provision', mode: 'keyed' }] },
            action: { id: 'provision', mode: 'keyed' },
            execution: { kind: 'generated_key' },
        },
        {
            method: EMAIL_PASSWORD_METHOD,
            action: { id: 'provision', mode: 'either' },
            execution: { kind: 'email_password', action: 'provision', mode: 'either' },
        },
        {
            method: EMAIL_PASSWORD_METHOD,
            action: { id: 'login', mode: 'either' },
            execution: { kind: 'email_password', action: 'login', mode: 'either' },
        },
    ],
    serverAvailability: 'ready',
    authEntryUnavailable: false,
    serverUrlForCopy: 'https://relay.example.test',
    showAuthActions: true,
    retryServerCheck: () => {},
};

function renderPanel(overrides: Partial<AuthEntryOptions> = {}, restoreWays = false) {
    const callbacks = {
        onContinueWithHomeAuthentication: vi.fn(),
        onOpenRestore: vi.fn(),
        onChangeRelay: vi.fn(),
        onConnectHomeDirectly: vi.fn(),
    };
    return {
        callbacks,
        screenPromise: renderScreen(
            <WelcomeDecisionPanel
                authEntryOptions={{ ...baseOptions, ...overrides }}
                restoreWays={restoreWays}
                {...callbacks}
            />,
        ),
    };
}

describe('WelcomeDecisionPanel native email/password entry', () => {
    it('labels each native action by its own journey instead of an OAuth provider badge', async () => {
        const { callbacks, screenPromise } = renderPanel({}, true);
        const screen = await screenPromise;

        // The login action must reach its own controller with sign-in wording.
        expect(screen.findByTestId('welcome-email-password-login')?.props.accessibilityLabel)
            .toBe('Email and password');
        // The extra provision action must not repeat the generic "New here?" card.
        expect(screen.findByTestId('welcome-email-password-provision')?.props.accessibilityLabel)
            .toBe(t('settingsAccount.nativePassword.signUpWithEmail'));
        expect(screen.findAllHostsByTestId('restore-new-account')).toHaveLength(1);

        await screen.pressByTestIdAsync('welcome-email-password-login');
        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
            action: { id: 'login', mode: 'either' },
            execution: { kind: 'email_password', action: 'login', mode: 'either' },
            method: expect.objectContaining({ id: 'email_password' }),
        }));
    });

    it('keeps the single native provision action as the New here entry', async () => {
        const { screenPromise } = renderPanel({
            authenticationActions: [{
                method: EMAIL_PASSWORD_METHOD,
                action: { id: 'provision', mode: 'either' },
                execution: { kind: 'email_password', action: 'provision', mode: 'either' },
            }],
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-primary-start-title')?.props.children).toBe(t('welcome.welcomePrimaryButton'));
        expect(screen.findAllByTestId('welcome-email-password-provision')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-signup-disabled')).toHaveLength(0);
    });

    it('keeps native login available while explaining closed signup', async () => {
        const { screenPromise } = renderPanel({
            authenticationActions: [{
                method: EMAIL_PASSWORD_METHOD,
                action: { id: 'login', mode: 'either' },
                execution: { kind: 'email_password', action: 'login', mode: 'either' },
            }],
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-email-password-login')).toBeTruthy();
        expect(screen.findByTestId('welcome-signup-disabled')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
    });

    it.each(['loading', 'unavailable', 'incompatible'] as const)(
        'does not infer closed signup while the Home is %s',
        async (serverAvailability) => {
            const { screenPromise } = renderPanel({
                serverAvailability,
                authenticationActions: [],
            });
            const screen = await screenPromise;

            expect(screen.findAllByTestId('welcome-signup-disabled')).toHaveLength(0);
        },
    );

    it('does not infer closed signup without an observed action projection', async () => {
        const { screenPromise } = renderPanel({
            authenticationActions: undefined,
        });
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-signup-disabled')).toHaveLength(0);
    });
});
