import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWelcomeScreen, waitForWelcomeTestId } from './index.testHelpers';
import { createExpoRouterMock, standardCleanup } from '@/dev/testkit';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const expoRouterMock = createExpoRouterMock();

const authEntryOptionsState = vi.hoisted(() => ({
    current: {
        serverAvailability: 'ready',
        showAnonymousSignup: true,
        showProviderSignup: false,
        showMtlsLogin: false,
        showKeylessProviderLogin: false,
        providerSignupTitle: 'Continue with GitHub',
        providerKeylessTitle: 'Continue with GitHub',
        anonymousSignupTitle: 'Create account',
        mtlsTitle: 'Sign in with certificate',
        keylessPrimary: false,
    },
}));

vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));
vi.mock('@/components/navigation/shell/HomeHeader', () => ({ HomeHeaderNotAuth: () => null }));
vi.mock('@/components/navigation/shell/MainView', () => ({ MainView: () => null }));
vi.mock('@shopify/react-native-skia', () => ({}));
vi.mock('expo-camera', () => ({
    CameraView: () => null,
    Camera: () => null,
}));
vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_sign_seed_keypair: () => ({
            publicKey: new Uint8Array(),
            privateKey: new Uint8Array(),
        }),
    },
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: false,
        credentials: null,
        login: vi.fn(async () => {}),
        logout: vi.fn(async () => {}),
    }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverUrl: 'https://server.test', serverId: 'server-1' }),
}));

vi.mock('@/sync/domains/server/url/shouldHoldUnauthenticatedShellForWebServerOverride', () => ({
    shouldHoldUnauthenticatedShellForWebServerOverride: () => false,
}));

vi.mock('@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry', () => ({
    PreAuthOnboardingWizardEntry: () => {
        const options = authEntryOptionsState.current;
        const nodes: React.ReactNode[] = [];

        if (options.serverAvailability === 'unavailable' || options.serverAvailability === 'incompatible') {
            nodes.push(React.createElement('Blocked', { key: 'blocked', testID: 'welcome-server-unavailable' }));
            nodes.push(React.createElement('Configure', { key: 'configure', testID: 'welcome-configure-server' }));
            nodes.push(React.createElement('Retry', { key: 'retry', testID: 'welcome-retry-server' }));
            return React.createElement('PreAuthOnboardingWizardEntry', { testID: 'pre-auth-entry' }, nodes);
        }

        if (options.showAnonymousSignup) {
            nodes.push(React.createElement('PrimaryStart', {
                key: 'welcome-primary-start',
                testID: 'welcome-primary-start',
            }, options.anonymousSignupTitle));
            nodes.push(React.createElement('CreateAccount', {
                key: 'welcome-create-account',
                testID: 'welcome-create-account',
            }, options.anonymousSignupTitle));
        }

        if (options.showProviderSignup) {
            nodes.push(React.createElement('ProviderSignup', {
                key: 'welcome-signup-provider',
                testID: 'welcome-signup-provider',
            }, options.providerSignupTitle));
        }

        if (options.showKeylessProviderLogin) {
            nodes.push(React.createElement(
                options.keylessPrimary ? 'ProviderPrimary' : 'KeylessSecondary',
                {
                    key: options.keylessPrimary ? 'welcome-provider-primary' : 'welcome-login-provider',
                    testID: options.keylessPrimary ? 'welcome-provider-primary' : 'welcome-login-provider',
                },
                options.providerKeylessTitle,
            ));
        }

        if (options.showMtlsLogin) {
            nodes.push(React.createElement('MtlsPrimary', {
                key: 'welcome-mtls-primary',
                testID: 'welcome-mtls-primary',
            }, options.mtlsTitle));
        }

        return React.createElement('PreAuthOnboardingWizardEntry', { testID: 'pre-auth-entry' }, nodes);
    },
}));

describe('/ (welcome) signup methods', () => {
    beforeEach(() => {
        authEntryOptionsState.current = {
            serverAvailability: 'ready',
            showAnonymousSignup: true,
            showProviderSignup: false,
            showMtlsLogin: false,
            showKeylessProviderLogin: false,
            providerSignupTitle: 'Continue with GitHub',
            providerKeylessTitle: 'Continue with GitHub',
            anonymousSignupTitle: 'Create account',
            mtlsTitle: 'Sign in with certificate',
            keylessPrimary: false,
        };
    });

    afterEach(standardCleanup);

    it('shows Create account and provider option when both are enabled', async () => {
        authEntryOptionsState.current = {
            ...authEntryOptionsState.current,
            showProviderSignup: true,
        };

        const screen = await renderWelcomeScreen();

        await waitForWelcomeTestId(screen, 'welcome-create-account');

        expect(screen.findAllByTestId('welcome-create-account')).toHaveLength(1);
        expect(screen.findAllByTestId('welcome-signup-provider')).toHaveLength(1);
    });

    it('shows keyless provider login as the primary action when anonymous signup is disabled', async () => {
        authEntryOptionsState.current = {
            ...authEntryOptionsState.current,
            showAnonymousSignup: false,
            showKeylessProviderLogin: true,
            keylessPrimary: true,
        };

        const screen = await renderWelcomeScreen();

        await waitForWelcomeTestId(screen, 'welcome-provider-primary');

        expect(screen.findAllByTestId('welcome-provider-primary')).toHaveLength(1);
        expect(screen.findAllByTestId('welcome-create-account')).toHaveLength(0);
    });

    it('keeps a secondary keyless provider login action when anonymous signup stays primary', async () => {
        authEntryOptionsState.current = {
            ...authEntryOptionsState.current,
            showKeylessProviderLogin: true,
            keylessPrimary: false,
        };

        const screen = await renderWelcomeScreen();

        await waitForWelcomeTestId(screen, 'welcome-login-provider');

        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(1);
        expect(screen.findAllByTestId('welcome-login-provider')).toHaveLength(1);
    });

    it('shows mTLS login when that is the only available auth action', async () => {
        authEntryOptionsState.current = {
            ...authEntryOptionsState.current,
            showAnonymousSignup: false,
            showMtlsLogin: true,
        };

        const screen = await renderWelcomeScreen();

        await waitForWelcomeTestId(screen, 'welcome-mtls-primary');

        expect(screen.findAllByTestId('welcome-mtls-primary')).toHaveLength(1);
        expect(screen.findAllByTestId('welcome-create-account')).toHaveLength(0);
    });

    it('shows a server unavailable notice and hides auth actions when the server cannot be reached', async () => {
        authEntryOptionsState.current = {
            ...authEntryOptionsState.current,
            serverAvailability: 'unavailable',
            showAnonymousSignup: false,
            showProviderSignup: false,
        };

        const screen = await renderWelcomeScreen();

        await waitForWelcomeTestId(screen, 'welcome-server-unavailable');

        expect(screen.findAllByTestId('welcome-server-unavailable')).toHaveLength(1);
        expect(screen.findAllByTestId('welcome-configure-server')).toHaveLength(1);
        expect(screen.findAllByTestId('welcome-retry-server')).toHaveLength(1);
        expect(screen.findAllByTestId('welcome-create-account')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-signup-provider')).toHaveLength(0);
    });
});
