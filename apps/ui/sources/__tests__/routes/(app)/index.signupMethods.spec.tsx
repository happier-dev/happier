import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createWelcomeFeaturesResponse,
    renderWelcomeScreen,
    waitForWelcomeTestId,
    waitForWelcomeText,
} from './index.testHelpers';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import type { FeaturesResponse } from '@happier-dev/protocol';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));
vi.mock('@/components/navigation/shell/HomeHeader', () => ({ HomeHeaderNotAuth: () => null }));
vi.mock('@/components/navigation/shell/MainView', () => ({ MainView: () => null }));
vi.mock('@shopify/react-native-skia', () => ({}));

const applyBrandHeroSeenSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/onboarding/unauthShell', async () => {
    const React = await import('react');
    return {
        UnauthenticatedSplitShell: (props: {
            children?: React.ReactNode;
            stepId: string;
            isWelcomeStep: boolean;
            allowMobileBrandHero?: boolean;
            onOpenRelayCustomFlow: () => void;
            onBrandHeroGetStarted: () => void;
            onBack?: () => void;
        }) =>
            React.createElement(
                'UnauthenticatedSplitShell',
                {
                    stepId: props.stepId,
                    isWelcomeStep: props.isWelcomeStep,
                    allowMobileBrandHero: props.allowMobileBrandHero,
                    onOpenRelayCustomFlow: props.onOpenRelayCustomFlow,
                    onBrandHeroGetStarted: props.onBrandHeroGetStarted,
                    hasBack: typeof props.onBack === 'function',
                    testID: `unauth-shell-route-${props.stepId}`,
                },
                props.children,
            ),
        useApplyBrandHeroSeen: () => applyBrandHeroSeenSpy,
    };
});
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

const getReadyServerFeaturesMock = vi.fn(async () =>
    createWelcomeFeaturesResponse({
        signupMethods: [
            { id: 'anonymous', enabled: false },
            { id: 'github', enabled: true },
        ],
        requiredProviders: ['github'],
        autoRedirectEnabled: false,
        autoRedirectProviderId: null,
        providerOffboardingIntervalSeconds: 600,
    }),
);

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: getReadyServerFeaturesMock,
}));

const defaultWelcomeFeatures = createWelcomeFeaturesResponse({
    signupMethods: [
        { id: 'anonymous', enabled: false },
        { id: 'github', enabled: true },
    ],
    requiredProviders: ['github'],
    autoRedirectEnabled: false,
    autoRedirectProviderId: null,
    providerOffboardingIntervalSeconds: 600,
});

const getServerFeaturesSnapshotMock = vi.fn(async (_params?: unknown): Promise<ServerFeaturesSnapshot> => ({
    status: 'ready',
    features: defaultWelcomeFeatures,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: getServerFeaturesSnapshotMock,
}));

describe('/ (welcome) signup methods', () => {
    beforeEach(() => {
        applyBrandHeroSeenSpy.mockReset();
        getReadyServerFeaturesMock.mockReset();
        getReadyServerFeaturesMock.mockResolvedValue(defaultWelcomeFeatures);
        getServerFeaturesSnapshotMock.mockReset();
        getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'ready', features: defaultWelcomeFeatures });
    });
    afterEach(standardCleanup);

    it('uses an extended initial server-features timeout before showing the server unavailable state', async () => {
        vi.resetModules();
        const screen = await renderWelcomeScreen();

        expect(screen.root).toBeTruthy();
        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledWith({
            timeoutMs: 6000,
            force: false,
        });
    });

    it('renders the unauthenticated welcome route inside the split shell', async () => {
        vi.resetModules();
        const screen = await renderWelcomeScreen();

        const shell = screen.findByTestId('unauth-shell-route-welcome');
        expect(shell).toBeTruthy();
        expect(shell?.props.stepId).toBe('welcome');
        expect(shell?.props.isWelcomeStep).toBe(true);
        expect(shell?.props.allowMobileBrandHero).toBe(true);

        shell?.props.onBrandHeroGetStarted();
        expect(applyBrandHeroSeenSpy).toHaveBeenCalledTimes(1);

        expect(shell?.props.onOpenRelayCustomFlow).toBeTypeOf('function');
        expect(screen.findAllByTestId('welcome-hero')).toHaveLength(0);
    });

    it('shows anonymous primary and provider option when both are enabled', async () => {
        vi.resetModules();
        const { t } = await import('@/text');
        const bothEnabled = createWelcomeFeaturesResponse({
            signupMethods: [
                { id: 'anonymous', enabled: true },
                { id: 'github', enabled: true },
            ],
            requiredProviders: [],
            autoRedirectEnabled: false,
            autoRedirectProviderId: null,
            providerOffboardingIntervalSeconds: 600,
        });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({ status: 'ready', features: bothEnabled });

        const screen = await renderWelcomeScreen();
        const providerTitle = t('welcome.signUpWithProvider', { provider: 'GitHub' });
        const textContent = await waitForWelcomeText(screen, providerTitle);

        expect(textContent).toContain(providerTitle);
        expect(screen.findAllByTestId('welcome-primary-start').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('welcome-signup-provider').length).toBeGreaterThan(0);
    });

    it('prefers auth.methods over legacy signup/login methods when present', async () => {
        vi.resetModules();
        const { t } = await import('@/text');

        const authMethods = [
            {
                id: 'key_challenge',
                actions: [
                    { id: 'login' as const, enabled: true, mode: 'keyed' as const },
                    { id: 'provision' as const, enabled: false, mode: 'keyed' as const },
                ],
                ui: { displayName: 'Device key', iconHint: null },
            },
            {
                id: 'github',
                actions: [{ id: 'provision' as const, enabled: true, mode: 'keyed' as const }],
                ui: { displayName: 'GitHub', iconHint: 'github' },
            },
        ] satisfies NonNullable<FeaturesResponse['capabilities']['auth']['methods']>;

        const payload = createWelcomeFeaturesResponse({
            // Legacy says anonymous signup is enabled…
            signupMethods: [
                { id: 'anonymous', enabled: true },
                { id: 'github', enabled: true },
            ],
            // …but auth.methods disables key_challenge provisioning, so anonymous signup must be hidden.
            authMethods,
            requiredProviders: [],
            autoRedirectEnabled: false,
            autoRedirectProviderId: null,
            providerOffboardingIntervalSeconds: 600,
        });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({ status: 'ready', features: payload });

        const screen = await renderWelcomeScreen();
        const providerTitle = t('welcome.signUpWithProvider', { provider: 'GitHub' });
        const textContent = await waitForWelcomeText(screen, providerTitle);

        expect(textContent).toContain(providerTitle);
        expect(textContent).not.toContain(t('welcome.createAccount'));
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-signup-provider').length).toBeGreaterThan(0);
    });

    it('hides anonymous primary when anonymous signup is disabled and shows provider option', async () => {
        vi.resetModules();
        const { t } = await import('@/text');
        const screen = await renderWelcomeScreen();
        const providerTitle = t('welcome.signUpWithProvider', { provider: 'GitHub' });
        const textContent = await waitForWelcomeText(screen, providerTitle);

        expect(textContent).not.toContain(t('welcome.createAccount'));
        expect(textContent).toContain(providerTitle);
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-signup-provider').length).toBeGreaterThan(0);
    });

    it('hides every signup entry and keeps login when the server disables all signup methods', async () => {
        vi.resetModules();
        // Mirrors a real self-hosted shape (AUTH_ANONYMOUS_SIGNUP_ENABLED=0, no
        // OAuth/mTLS): only key_challenge *login* is enabled, no provision
        // action anywhere. The welcome screen must not offer Create account.
        const loginOnly = createWelcomeFeaturesResponse({
            signupMethods: [{ id: 'anonymous', enabled: false }],
            loginMethods: [{ id: 'key_challenge', enabled: true }],
            authMethods: [
                {
                    id: 'key_challenge',
                    actions: [
                        { id: 'login', enabled: true, mode: 'keyed' },
                        { id: 'provision', enabled: false, mode: 'keyed' },
                    ],
                    ui: { displayName: 'Device key', iconHint: null },
                },
                {
                    id: 'mtls',
                    actions: [
                        { id: 'login', enabled: false, mode: 'keyless' },
                        { id: 'provision', enabled: false, mode: 'keyless' },
                    ],
                    ui: { displayName: 'Certificate', iconHint: null },
                },
                {
                    id: 'github',
                    actions: [
                        { id: 'connect', enabled: false, mode: 'either' },
                        { id: 'provision', enabled: false, mode: 'keyed' },
                        { id: 'login', enabled: false, mode: 'keyless' },
                        { id: 'provision', enabled: false, mode: 'keyless' },
                    ],
                    ui: { displayName: 'GitHub', iconHint: 'github' },
                },
            ],
            requiredProviders: [],
            autoRedirectEnabled: false,
            autoRedirectProviderId: null,
            providerOffboardingIntervalSeconds: 600,
        });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({ status: 'ready', features: loginOnly });

        const screen = await renderWelcomeScreen();
        expect(await waitForWelcomeTestId(screen, 'welcome-secondary-login')).toBeGreaterThan(0);
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-create-account')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-signup-provider')).toHaveLength(0);
    });

    it('shows mTLS login when signup methods are disabled but mTLS is enabled', async () => {
        vi.resetModules();
        const { t } = await import('@/text');
        const mtlsOnly = createWelcomeFeaturesResponse({
            signupMethods: [{ id: 'anonymous', enabled: false }],
            loginMethods: [{ id: 'mtls', enabled: true }],
            authMtlsEnabled: true,
            requiredProviders: [],
            autoRedirectEnabled: false,
            autoRedirectProviderId: null,
            providerOffboardingIntervalSeconds: 600,
        });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({ status: 'ready', features: mtlsOnly });

        const screen = await renderWelcomeScreen();
        const mtlsTitle = t('welcome.signInWithCertificate');
        const textContent = await waitForWelcomeText(screen, mtlsTitle);

        expect(textContent).toContain(mtlsTitle);
        expect(textContent).not.toContain(t('welcome.createAccount'));
    });

    it('shows keyless provider login when signup methods are disabled but a keyless OAuth login method is enabled', async () => {
        vi.resetModules();
        const { t } = await import('@/text');
        const keylessOnly = createWelcomeFeaturesResponse({
            signupMethods: [{ id: 'anonymous', enabled: false }],
            loginMethods: [],
            authMethods: [
                {
                    id: 'key_challenge',
                    actions: [
                        { id: 'login', enabled: false, mode: 'keyed' },
                        { id: 'provision', enabled: false, mode: 'keyed' },
                    ],
                    ui: { displayName: 'Device key', iconHint: null },
                },
                {
                    id: 'github',
                    actions: [{ id: 'login', enabled: true, mode: 'keyless' }],
                    ui: { displayName: 'GitHub', iconHint: 'github' },
                },
            ],
            requiredProviders: [],
            autoRedirectEnabled: false,
            autoRedirectProviderId: null,
            providerOffboardingIntervalSeconds: 600,
        });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({ status: 'ready', features: keylessOnly });

        const screen = await renderWelcomeScreen();
        const providerTitle = t('welcome.signUpWithProvider', { provider: 'GitHub' });
        const textContent = await waitForWelcomeText(screen, providerTitle);

        expect(textContent).toContain(providerTitle);
        expect(textContent).not.toContain(t('welcome.createAccount'));
        expect(screen.findByTestId('welcome-create-account')).not.toBeNull();
    });

    it('shows a server unavailable notice and hides auth actions when the server cannot be reached', async () => {
        vi.resetModules();
        vi.useFakeTimers();
        process.env.EXPO_PUBLIC_HAPPIER_WELCOME_SERVER_CHECK_RETRY_DELAY_MS = '1';
        const { t } = await import('@/text');
        getServerFeaturesSnapshotMock.mockClear();
        getServerFeaturesSnapshotMock
            .mockResolvedValueOnce({ status: 'error', reason: 'network' })
            .mockResolvedValueOnce({ status: 'error', reason: 'network' });

        try {
            const screen = await renderWelcomeScreen();

            expect(screen.findAllByTestId('welcome-server-unavailable')).toHaveLength(0);

            await flushHookEffects({ advanceTimersMs: 1 });
            await waitForWelcomeTestId(screen, 'welcome-server-unavailable');

            expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(2);

            expect(screen.findAllByTestId('welcome-server-unavailable')).toHaveLength(1);
            expect(screen.getTextContent()).toContain(t('welcome.serverUnavailableTitle'));
            expect(screen.findAllByTestId('welcome-secondary-login')).toHaveLength(0);
            expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
            expect(screen.findAllByTestId('welcome-signup-provider')).toHaveLength(0);
            expect(screen.findAllByTestId('welcome-create-account')).toHaveLength(0);
            expect(screen.findByTestId('welcome-retry-server')).not.toBeNull();
            expect(screen.findByTestId('welcome-change-relay')).not.toBeNull();
        } finally {
            delete process.env.EXPO_PUBLIC_HAPPIER_WELCOME_SERVER_CHECK_RETRY_DELAY_MS;
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('shows a server incompatible notice and hides auth actions when the server features response is invalid', async () => {
        vi.resetModules();
        const { t } = await import('@/text');
        getServerFeaturesSnapshotMock.mockClear();
        getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'unsupported', reason: 'invalid_payload' });

        const screen = await renderWelcomeScreen();

        await waitForWelcomeTestId(screen, 'welcome-server-unavailable');

        expect(getServerFeaturesSnapshotMock).toHaveBeenCalled();
        expect(screen.findAllByTestId('welcome-server-unavailable')).toHaveLength(1);
        expect(screen.getTextContent()).toContain(t('welcome.serverIncompatibleTitle'));
        expect(screen.findAllByTestId('welcome-secondary-login')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-signup-provider')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-create-account')).toHaveLength(0);
        expect(screen.findByTestId('welcome-retry-server')).not.toBeNull();
        expect(screen.findByTestId('welcome-change-relay')).not.toBeNull();
    });
});
