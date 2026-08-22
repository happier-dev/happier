import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

const reactNativeState = vi.hoisted(() => ({
    width: 390,
    height: 844,
}));

const routerMocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
    login: vi.fn(async () => ({ kind: 'completed' as const })),
    loginWithCredentials: vi.fn(async () => ({
        kind: 'completed' as const,
    })),
}));

const serverFetchMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());

const authEntryOptionsState = vi.hoisted(() => ({
    current: {
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
        anonymousSignupTitle: 'welcome.createAccount',
        mtlsTitle: '',
        primaryAction: {
            kind: 'anonymous' as const,
            title: 'welcome.createAccount',
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
        retryServerCheck: vi.fn(),
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({
            width: reactNativeState.width,
            height: reactNativeState.height,
            scale: 2,
            fontScale: 1,
        }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', () => createExpoRouterMock({
    router: {
        push: routerMocks.push,
        replace: routerMocks.replace,
        back: routerMocks.back,
    },
}).module);

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('ExpoImage', props),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({
    default: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@react-native/virtualized-lists', () => ({
    VirtualizedList: 'VirtualizedList',
    VirtualizedSectionList: 'VirtualizedSectionList',
}));

vi.mock('react-native-keyboard-controller', () => ({}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalAlertMock } }).module;
});

vi.mock('@/sync/http/client', async () => {
    const actual = await vi.importActual<typeof import('@/sync/http/client')>('@/sync/http/client');
    return {
        ...actual,
        serverFetch: serverFetchMock,
    };
});

vi.mock('@/assets/onboarding/planet-dark.jpg', () => ({ default: 'planet-dark.jpg' }));
vi.mock('@/assets/onboarding/planet-light.jpg', () => ({ default: 'planet-light.jpg' }));
vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light.png' }));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: false,
        login: authMock.login,
        loginWithCredentials: authMock.loginWithCredentials,
    }),
}));

vi.mock('@/components/account/auth/useAuthEntryOptions', () => ({
    useAuthEntryOptions: () => authEntryOptionsState.current,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: vi.fn((size: number) => new Uint8Array(size).fill(3)),
    getRandomBytesAsync: vi.fn(async (size: number) => new Uint8Array(size).fill(7)),
}));

vi.mock('@/track', () => ({
    tracking: null,
    trackAccountCreated: vi.fn(),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsLandscape: () => false,
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => false,
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => null,
    setPendingSetupIntent: vi.fn(),
    clearPendingSetupIntent: () => {},
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'https://relay.example.test',
        generation: 1,
    }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/domains/server/readConfiguredServerUrlEnv', () => ({
    readConfiguredServerUrlEnv: () => '',
    readConfiguredServerUrlEnvRaw: () => '',
}));

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_box_seed_keypair: () => ({
            publicKey: new Uint8Array([1]),
            privateKey: new Uint8Array([2]),
        }),
        crypto_sign_seed_keypair: () => ({
            publicKey: new Uint8Array([1]),
            privateKey: new Uint8Array([2]),
        }),
        crypto_sign_detached: () => new Uint8Array([3]),
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('PreAuthOnboardingWizardEntry shell integration', () => {
    let previousStorageState: StorageState;
    let nowSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        resetServerFeaturesClientForTests();
        previousStorageState = storage.getState();
        act(() => {
            storage.setState((state) => ({
                ...state,
                localSettings: {
                    ...localSettingsDefaults,
                    brandHeroSeenAt: null,
                },
            }));
        });
        nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_789_000_000_000);
        reactNativeState.width = 390;
        reactNativeState.height = 844;
        authMock.login.mockClear();
        authMock.loginWithCredentials.mockClear();
        serverFetchMock.mockReset();
        serverFetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
        modalAlertMock.mockClear();
        authEntryOptionsState.current.retryServerCheck.mockClear();
        routerMocks.push.mockClear();
        routerMocks.replace.mockClear();
        routerMocks.back.mockClear();
        authEntryOptionsState.current = {
            ...authEntryOptionsState.current,
            serverAvailability: 'ready',
            showAuthActions: true,
            showAnonymousSignup: true,
            showProviderSignup: false,
            showMtlsLogin: false,
            showKeylessProviderLogin: false,
        };
    });

    afterEach(() => {
        nowSpy.mockRestore();
        act(() => {
            storage.setState(previousStorageState, true);
        });
        standardCleanup();
    });

    it('dismisses the mobile brand hero locally and reveals welcome without changing wizard step', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);

        expect(screen.findByTestId('brand-hero-get-started')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-route-welcome')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-decision-panel')).toHaveLength(0);

        await act(async () => {
            screen.pressByTestId('brand-hero-get-started');
        });
        await flushHookEffects();

        expect(storage.getState().localSettings.brandHeroSeenAt).toBe(1_789_000_000_000);
        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
        expect(screen.findAllByTestId('unauth-shell-back-chevron')).toHaveLength(0);
    });

    it('shows split shell immediately on desktop and creates an anonymous account from welcome', async () => {
        reactNativeState.width = 1100;
        reactNativeState.height = 720;
        serverFetchMock.mockImplementation(async (path: string) => (
            path === '/v1/auth'
                ? new Response(JSON.stringify({ token: 'account-token' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(null, { status: 404 })
        ));

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);

        expect(screen.findByTestId('onboarding-wizard')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-route-welcome')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-brand-pane')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-workflow-pane')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-primary-start');
        await flushHookEffects();

        expect(authMock.login).toHaveBeenCalledWith('account-token', expect.any(String));
    });

    it('surfaces raced signup policy and requests a capability refresh instead of a generic failure', async () => {
        reactNativeState.width = 1100;
        reactNativeState.height = 720;
        serverFetchMock.mockImplementation(async (path: string) => (
            path === '/v1/auth'
                ? new Response(JSON.stringify({ error: 'signup-disabled' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(null, { status: 404 })
        ));

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);

        await screen.pressByTestIdAsync('welcome-primary-start');
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(authEntryOptionsState.current.retryServerCheck).toHaveBeenCalledTimes(1);
        expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'errors.signupDisabled');
        expect(authMock.login).not.toHaveBeenCalled();
    });

    it('keeps returning mobile users in workflow and navigates restore and relay through the shell', async () => {
        act(() => {
            storage.setState((state) => ({
                ...state,
                localSettings: {
                    ...state.localSettings,
                    brandHeroSeenAt: 1_700_000_000_000,
                },
            }));
        });

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);

        expect(screen.findAllByTestId('brand-hero-get-started')).toHaveLength(0);
        expect(screen.findByTestId('welcome-secondary-login')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-secondary-login');
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('unauth-shell-route-restore')).toBeTruthy();
        expect(screen.findByTestId('restore-route-content')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-back-chevron')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-secondary-login')).toHaveLength(0);

        await screen.pressByTestIdAsync('unauth-shell-back-chevron');
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('welcome-secondary-login')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-footer-relay-action');
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('unauth-shell-route-setup-pre-auth')).toBeTruthy();
        expect(screen.findByTestId('relay-select-route-content')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-back-chevron')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-secondary-login')).toHaveLength(0);
    });
});
