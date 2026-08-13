import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createWelcomeFeaturesResponse,
    renderWelcomeScreen,
    waitForWelcomeTestId,
} from './index.testHelpers';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';

const reactNativeState = vi.hoisted(() => ({
    width: 390,
    height: 844,
    platformOs: 'web' as 'web' | 'ios' | 'android',
}));

const routerMocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
}));

const routerParams = vi.hoisted(() => ({
    current: {} as Record<string, string | string[] | undefined>,
}));

const authMock = vi.hoisted(() => ({
    isAuthenticated: false,
    login: vi.fn(async () => {}),
    loginWithCredentials: vi.fn(async () => {}),
}));

const tokenStorageState = vi.hoisted(() => ({
    pendingExternalAuthState: null as null | Record<string, unknown>,
}));

const serverRuntimeState = vi.hoisted(() => ({
    snapshot: {
        serverId: 'relay-1',
        serverUrl: 'https://relay.example.test/',
        generation: 1,
    },
    listeners: new Set<() => void>(),
}));

const getServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());

const authGetTokenMock = vi.hoisted(() => vi.fn(async () => 'account-token'));

const modalAlertSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));
vi.mock('@shopify/react-native-skia', () => ({}));
vi.mock('react-native-keyboard-controller', () => ({}));
vi.mock('@react-native/virtualized-lists', () => ({
    VirtualizedList: 'VirtualizedList',
    VirtualizedSectionList: 'VirtualizedSectionList',
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
        Dimensions: {
            get: () => ({
                width: reactNativeState.width,
                height: reactNativeState.height,
                scale: 2,
                fontScale: 1,
            }),
        },
        Platform: {
            OS: reactNativeState.platformOs,
            select: (options: Record<string, unknown>) =>
                options?.[reactNativeState.platformOs] ?? options?.web ?? options?.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerMocks.push,
            replace: routerMocks.replace,
            back: routerMocks.back,
        },
        params: () => routerParams.current,
    }).module;
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('ExpoImage', props),
}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: (props: Record<string, unknown>) => React.createElement('LinearGradient', props),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({
    default: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));
vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
}));

vi.mock('@/assets/onboarding/planet-dark.jpg', () => ({ default: 'planet-dark.jpg' }));
vi.mock('@/assets/onboarding/planet-light.jpg', () => ({ default: 'planet-light.jpg' }));
vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light.png' }));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({ HomeHeaderNotAuth: () => null }));
vi.mock('@/components/navigation/shell/MainView', () => ({ MainView: () => null }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: authMock.isAuthenticated,
        credentials: null,
        login: authMock.login,
        loginWithCredentials: authMock.loginWithCredentials,
        logout: vi.fn(async () => {}),
    }),
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: (params?: unknown) => getServerFeaturesSnapshotMock(params),
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: vi.fn(async () => null),
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: vi.fn((size: number) => new Uint8Array(size).fill(3)),
    getRandomBytesAsync: vi.fn(async (size: number) => new Uint8Array(size).fill(7)),
}));

vi.mock('@/auth/flows/getToken', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/flows/getToken')>();
    return {
        ...actual,
        authGetToken: authGetTokenMock,
    };
});

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: vi.fn(async () => false),
}));

vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: vi.fn(async () => null),
}));

vi.mock('@/components/qr/QRCode', () => ({
    QRCode: (props: Record<string, unknown>) => React.createElement('QRCode', props),
}));

vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
    CameraView: {
        isModernBarcodeScannerAvailable: false,
        launchScanner: vi.fn(),
        dismissScanner: vi.fn(async () => {}),
        onModernBarcodeScanned: vi.fn(() => ({ remove: () => {} })),
    },
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => null,
    setPendingSetupIntent: vi.fn(),
    clearPendingSetupIntent: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => serverRuntimeState.snapshot,
    setActiveServer: vi.fn(),
    subscribeActiveServer: (listener: () => void) => {
        serverRuntimeState.listeners.add(listener);
        return () => {
            serverRuntimeState.listeners.delete(listener);
        };
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createServerProfilesModuleMock({
        importOriginal,
        overrides: {
            listServerProfiles: () => [
                {
                    id: 'relay-1',
                    name: 'Relay One',
                    serverUrl: 'https://relay.example.test',
                    createdAt: 0,
                    updatedAt: 0,
                    lastUsedAt: 0,
                },
            ],
            upsertServerProfile: vi.fn((params: { serverUrl: string }) => ({
                id: `server:${params.serverUrl}`,
                name: params.serverUrl,
                serverUrl: params.serverUrl,
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
            })),
        },
    });
});

vi.mock('@/sync/domains/server/serverConfig', () => ({
    validateServerUrl: () => ({ valid: true }),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => {
        void promise;
    },
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: vi.fn(async () => new Response(JSON.stringify({ token: 'mtls-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })),
}));

vi.mock('@/auth/flows/buildDataKeyCredentialsForToken', () => ({
    buildDataKeyCredentialsForToken: vi.fn(async (token: string) => ({ token, secret: 'secret' })),
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: (id: string) => ({ id, displayName: id === 'github' ? 'GitHub' : id }),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: vi.fn(async () => new Response(JSON.stringify({ token: 'oauth-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })),
}));

vi.mock('@/sync/api/capabilities/sessionSharingSupport', () => ({
    isSessionSharingSupported: vi.fn(async () => false),
}));

vi.mock('@/auth/oauth/contentKeyBinding', () => ({
    buildContentKeyBinding: vi.fn(async () => ({
        contentPublicKey: 'content-public-key',
        contentPublicKeySig: 'content-public-key-sig',
    })),
}));

vi.mock('@/auth/flows/challenge', () => ({
    authChallenge: vi.fn(() => ({
        challenge: new Uint8Array([1]),
        signature: new Uint8Array([2]),
        publicKey: new Uint8Array([3]),
    })),
}));

vi.mock('@/auth/storage/tokenStorage', async () => {
    const actual = await vi.importActual<typeof import('@/auth/storage/tokenStorage')>('@/auth/storage/tokenStorage');
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getAuthAutoRedirectSuppressedUntil: vi.fn(async () => 0),
            getCredentials: vi.fn(async () => null),
            getCredentialsForServerUrl: vi.fn(async () => null),
            invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
            readPendingExternalAuthState: vi.fn(async () => ({
                value: tokenStorageState.pendingExternalAuthState,
                serverMismatch: false,
            })),
            clearPendingExternalAuth: vi.fn(async () => true),
            setPendingExternalAuth: vi.fn(async () => true),
            clearPendingExternalConnect: vi.fn(async () => true),
        },
    };
});

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
    },
}));

vi.mock('@/track', () => ({
    tracking: null,
    trackAccountCreated: vi.fn(),
    trackAccountRestored: vi.fn(),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('unauthenticated route shell integration', () => {
    let previousStorageState: StorageState;
    let nowSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
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
        nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_789_111_000_000);
        reactNativeState.width = 390;
        reactNativeState.height = 844;
        reactNativeState.platformOs = 'web';
        routerParams.current = {};
        tokenStorageState.pendingExternalAuthState = null;
        authMock.isAuthenticated = false;
        authMock.login.mockClear();
        authMock.loginWithCredentials.mockClear();
        authGetTokenMock.mockReset();
        authGetTokenMock.mockResolvedValue('account-token');
        modalAlertSpy.mockClear();
        routerMocks.push.mockClear();
        routerMocks.replace.mockClear();
        routerMocks.back.mockClear();
        serverRuntimeState.listeners.clear();
        serverRuntimeState.snapshot = {
            serverId: 'relay-1',
            serverUrl: 'https://relay.example.test/',
            generation: 1,
        };
        getServerFeaturesSnapshotMock.mockReset();
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: createWelcomeFeaturesResponse({
                signupMethods: [{ id: 'anonymous', enabled: true }],
                loginMethods: [{ id: 'key_challenge', enabled: true }],
                requiredProviders: [],
                autoRedirectEnabled: false,
                autoRedirectProviderId: null,
            }),
        });
    });

    afterEach(() => {
        nowSpy.mockRestore();
        act(() => {
            storage.setState(previousStorageState, true);
        });
        vi.unstubAllGlobals();
        standardCleanup();
    });

    it('dismisses the mobile welcome brand hero locally and keeps welcome actions wired through the real shell', async () => {
        const screen = await renderWelcomeScreen();

        expect(screen.findByTestId('brand-hero-get-started')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-hero')).toHaveLength(0);

        await act(async () => {
            screen.pressByTestId('brand-hero-get-started');
        });
        await flushHookEffects();

        expect(storage.getState().localSettings.brandHeroSeenAt).toBe(1_789_111_000_000);
        expect(await waitForWelcomeTestId(screen, 'welcome-primary-start')).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('welcome-primary-start');
        await flushHookEffects();

        expect(authMock.login).toHaveBeenCalledWith('account-token', expect.any(String));

        await screen.pressByTestIdAsync('welcome-secondary-login');
        expect(routerMocks.push).toHaveBeenCalledWith('/restore');

        await screen.pressByTestIdAsync('welcome-footer-relay-action');
        expect(routerMocks.push).toHaveBeenCalledWith('/setup?openCustom=1');
    });

    it('shows a specific friendly message when account creation races a signup-disabled server', async () => {
        const { AuthTokenRequestError } = await import('@/auth/flows/getToken');
        authGetTokenMock.mockRejectedValueOnce(new AuthTokenRequestError(403, 'signup-disabled'));

        const screen = await renderWelcomeScreen();
        await act(async () => {
            screen.pressByTestId('brand-hero-get-started');
        });
        await flushHookEffects();
        expect(await waitForWelcomeTestId(screen, 'welcome-primary-start')).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('welcome-primary-start');
        await flushHookEffects();

        expect(authMock.login).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'errors.signupDisabled');
    });

    it('renders welcome as a desktop split without consuming the mobile hero flag', async () => {
        reactNativeState.width = 1100;
        reactNativeState.height = 720;

        const screen = await renderWelcomeScreen();

        expect(screen.findByTestId('unauth-shell-route-welcome')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-brand-pane')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-workflow-pane')).toBeTruthy();
        expect(await waitForWelcomeTestId(screen, 'welcome-primary-start')).toBeGreaterThan(0);
        expect(storage.getState().localSettings.brandHeroSeenAt).toBeNull();
    });

    it('does not show the mobile brand hero on restore, setup, or mtls deep-link routes', async () => {
        const { default: RestoreRoute } = await import('@/app/(app)/restore/index');
        const restoreScreen = await renderScreen(<RestoreRoute />);

        expect(restoreScreen.findByTestId('unauth-shell-route-restore')).toBeTruthy();
        expect(restoreScreen.findAllByTestId('brand-hero-get-started')).toHaveLength(0);

        const { default: SetupRoute } = await import('@/app/(app)/setup/index');
        const setupScreen = await renderScreen(<SetupRoute />);

        expect(setupScreen.findByTestId('unauth-shell-route-setup-pre-auth')).toBeTruthy();
        expect(setupScreen.findByTestId('relay-select-route-content')).toBeTruthy();
        expect(setupScreen.findByTestId('setup.currentRelay')).toBeTruthy();
        expect(setupScreen.findAllByTestId('setup.preAuth.intro')).toHaveLength(0);
        expect(setupScreen.findAllByTestId('brand-hero-get-started')).toHaveLength(0);

        const { default: MtlsRoute } = await import('@/app/(app)/mtls');
        const mtlsScreen = await renderScreen(<MtlsRoute />);

        expect(mtlsScreen.findByTestId('unauth-shell-route-mtls-callback')).toBeTruthy();
        expect(mtlsScreen.findAllByTestId('brand-hero-get-started')).toHaveLength(0);

        routerParams.current = {
            provider: 'github',
            flow: 'auth',
            pending: 'oauth-pending',
            storagePolicy: 'optional',
            provisioning: 'required',
        };
        tokenStorageState.pendingExternalAuthState = {
            provider: 'github',
            proof: 'oauth-proof',
            returnTo: '/',
            serverUrl: 'https://relay.example.test',
        };
        const { default: OAuthRoute } = await import('@/app/(app)/oauth/[provider]');
        const oauthScreen = await renderScreen(<OAuthRoute />);
        await flushHookEffects();

        expect(oauthScreen.findByTestId('unauth-shell-route-oauth-callback')).toBeTruthy();
        expect(oauthScreen.findByTestId('oauth-provisioning-choice-plain')).toBeTruthy();
        expect(oauthScreen.findAllByTestId('brand-hero-get-started')).toHaveLength(0);
    });
});
