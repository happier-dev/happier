import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    flushHookEffects,
    standardCleanup,
} from '@/dev/testkit';

import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createWelcomeFeaturesResponse, renderWelcomeScreen } from './index.testHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    clearPendingExternalAuthMock: vi.fn(async () => true),
    externalLoginUrl: 'https://example.test/oauth-login',
    externalSignupUrl: 'https://example.test/oauth',
    getSuppressedUntilMock: vi.fn(async () => 0),
    openURL: vi.fn(async () => true),
    setPendingExternalAuthMock: vi.fn(async () => true),
}));

let expoScheme: string | undefined = undefined;
vi.mock('expo-constants', () => ({
    default: {
        expoConfig: {
            get scheme() {
                return expoScheme;
            },
        },
    },
}));

vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));
vi.mock('@/components/navigation/shell/HomeHeader', () => ({ HomeHeaderNotAuth: () => null }));
vi.mock('@/components/navigation/shell/MainView', () => ({ MainView: () => null }));
vi.mock('@/components/ui/buttons/RoundButton', () => ({ RoundButton: () => null }));
vi.mock('@shopify/react-native-skia', () => ({}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: {
                    OS: 'ios',
                    select: (spec: Record<string, unknown>) => (spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? spec.ios : undefined),
                },
                Linking: { openURL: shared.openURL },
                useWindowDimensions: () => ({ width: 400, height: 800, scale: 1, fontScale: 1 }),
            }
    );
});

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

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytesAsync: async (n: number) => new Uint8Array(n).fill(9),
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: () => 'x',
}));

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_sign_seed_keypair: () => ({ publicKey: new Uint8Array([1]), privateKey: new Uint8Array([2]) }),
    },
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getAuthAutoRedirectSuppressedUntil: () => shared.getSuppressedUntilMock(),
        setPendingExternalAuth: () => shared.setPendingExternalAuthMock(),
        clearPendingExternalAuth: () => shared.clearPendingExternalAuthMock(),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => ({
        id: 'github',
        displayName: 'GitHub',
        getExternalAuthUrl: async (params: any) => {
            if (params?.mode === 'keyless') return shared.externalLoginUrl;
            return shared.externalSignupUrl;
        },
    }),
}));

const getServerFeaturesMock = vi.fn(async () =>
    createWelcomeFeaturesResponse({
        signupMethods: [
            { id: 'anonymous', enabled: false },
            { id: 'github', enabled: true },
        ],
        requiredProviders: ['github'],
        autoRedirectEnabled: true,
        autoRedirectProviderId: 'github',
        providerOffboardingIntervalSeconds: 86400,
    }),
);

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: getServerFeaturesMock,
}));

const getServerFeaturesSnapshotMock = vi.fn(async (_params?: unknown): Promise<ServerFeaturesSnapshot> => ({
    status: 'ready',
    features: createWelcomeFeaturesResponse({
        signupMethods: [
            { id: 'anonymous', enabled: false },
            { id: 'github', enabled: true },
        ],
        requiredProviders: ['github'],
        autoRedirectEnabled: true,
        autoRedirectProviderId: 'github',
        providerOffboardingIntervalSeconds: 86400,
    }),
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: getServerFeaturesSnapshotMock,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverUrl: 'https://server.test' }),
}));

describe('/ (welcome) auto redirect', () => {
    const testTimeoutMs = 60_000;

    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        expoScheme = undefined;
        shared.openURL.mockClear();
        getServerFeaturesMock.mockReset();
        getServerFeaturesMock.mockImplementation(async () =>
            createWelcomeFeaturesResponse({
                signupMethods: [
                    { id: 'anonymous', enabled: false },
                    { id: 'github', enabled: true },
                ],
                requiredProviders: ['github'],
                autoRedirectEnabled: true,
                autoRedirectProviderId: 'github',
                providerOffboardingIntervalSeconds: 86400,
            }),
        );
        getServerFeaturesSnapshotMock.mockReset();
        getServerFeaturesSnapshotMock.mockImplementation(async (_params?: unknown): Promise<ServerFeaturesSnapshot> => ({
            status: 'ready',
            features: createWelcomeFeaturesResponse({
                signupMethods: [
                    { id: 'anonymous', enabled: false },
                    { id: 'github', enabled: true },
                ],
                requiredProviders: ['github'],
                autoRedirectEnabled: true,
                autoRedirectProviderId: 'github',
                providerOffboardingIntervalSeconds: 86400,
            }),
        }));
        shared.setPendingExternalAuthMock.mockClear();
        shared.clearPendingExternalAuthMock.mockClear();
        shared.getSuppressedUntilMock.mockReset();
        shared.getSuppressedUntilMock.mockResolvedValue(0);
        shared.externalSignupUrl = 'https://example.test/oauth';
        shared.externalLoginUrl = 'https://example.test/oauth-login';
    });

    it('auto-starts provider signup when server enables auth.ui.autoRedirect', async () => {
        vi.resetModules();
        await renderWelcomeScreen();
        expect(shared.openURL).toHaveBeenCalledWith('https://example.test/oauth');
    }, testTimeoutMs);

    it('does not double-trigger auto-redirect when the effect runs twice before suppression is resolved', async () => {
        vi.resetModules();

        let resolveSuppressedUntil: ((value: number) => void) | undefined;
        const suppressedUntilPromise = new Promise<number>((resolve) => {
            resolveSuppressedUntil = resolve;
        });
        shared.getSuppressedUntilMock.mockImplementationOnce(async () => await suppressedUntilPromise);

        await renderWelcomeScreen({ strictMode: true });
        expect(shared.openURL).not.toHaveBeenCalled();

        resolveSuppressedUntil?.(0);
        await flushHookEffects();

        expect(shared.openURL).toHaveBeenCalledTimes(1);
    }, testTimeoutMs);

    it('does not auto-start provider signup when auto-redirect is temporarily suppressed', async () => {
        vi.resetModules();
        shared.getSuppressedUntilMock.mockResolvedValue(Date.now() + 60_000);

        await renderWelcomeScreen();
        expect(shared.openURL).not.toHaveBeenCalled();
    }, testTimeoutMs);

    it('does not throw when server features fetch fails', async () => {
        vi.resetModules();
        getServerFeaturesMock.mockRejectedValueOnce(new Error('network'));
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({ status: 'error', reason: 'network' });

        await renderWelcomeScreen();
        expect(shared.openURL).not.toHaveBeenCalled();
    }, testTimeoutMs);

    it('retries one transient server features failure before surfacing unavailable state', async () => {
        vi.resetModules();
        process.env.EXPO_PUBLIC_HAPPIER_WELCOME_SERVER_CHECK_RETRY_DELAY_MS = '1';

        getServerFeaturesSnapshotMock
            .mockResolvedValueOnce({ status: 'error', reason: 'network' })
            .mockResolvedValueOnce({
                status: 'ready',
                features: createWelcomeFeaturesResponse({
                    signupMethods: [{ id: 'anonymous', enabled: false }],
                    loginMethods: [{ id: 'mtls', enabled: true }],
                    autoRedirectEnabled: true,
                    autoRedirectProviderId: 'mtls',
                    providerOffboardingIntervalSeconds: 86400,
                }),
            });

        try {
            await renderWelcomeScreen();
            await flushHookEffects();
            expect(shared.openURL).not.toHaveBeenCalled();

            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
            });
            await flushHookEffects();

            expect(shared.openURL).toHaveBeenCalledWith('https://server.test/v1/auth/mtls/start?returnTo=happier%3A%2F%2F%2Fmtls');
        } finally {
            delete process.env.EXPO_PUBLIC_HAPPIER_WELCOME_SERVER_CHECK_RETRY_DELAY_MS;
        }
    }, testTimeoutMs);

    it('refuses unsafe external signup URLs', async () => {
        vi.resetModules();
        shared.externalSignupUrl = 'javascript:alert(1)';
        await renderWelcomeScreen();
        expect(shared.openURL).not.toHaveBeenCalled();
    }, testTimeoutMs);

    it('auto-starts mTLS login when server enables auth.ui.autoRedirect=mtls', async () => {
        vi.resetModules();
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: createWelcomeFeaturesResponse({
                signupMethods: [{ id: 'anonymous', enabled: false }],
                loginMethods: [{ id: 'mtls', enabled: true }],
                autoRedirectEnabled: true,
                autoRedirectProviderId: 'mtls',
                providerOffboardingIntervalSeconds: 86400,
            }),
        });

        await renderWelcomeScreen();
        expect(shared.openURL).toHaveBeenCalledWith('https://server.test/v1/auth/mtls/start?returnTo=happier%3A%2F%2F%2Fmtls');
    }, testTimeoutMs);

    it('uses the configured app scheme for the mTLS returnTo deep link', async () => {
        vi.resetModules();
        expoScheme = 'happier-dev';

        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: createWelcomeFeaturesResponse({
                signupMethods: [{ id: 'anonymous', enabled: false }],
                loginMethods: [{ id: 'mtls', enabled: true }],
                autoRedirectEnabled: true,
                autoRedirectProviderId: 'mtls',
                providerOffboardingIntervalSeconds: 86400,
            }),
        });

        await renderWelcomeScreen();
        expect(shared.openURL).toHaveBeenCalledWith('https://server.test/v1/auth/mtls/start?returnTo=happier-dev%3A%2F%2F%2Fmtls');
    }, testTimeoutMs);

    it('auto-starts keyless provider login when server enables auth.ui.autoRedirect for a keyless login method', async () => {
        vi.resetModules();
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: createWelcomeFeaturesResponse({
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
                autoRedirectEnabled: true,
                autoRedirectProviderId: 'github',
                providerOffboardingIntervalSeconds: 86400,
            }),
        });

        await renderWelcomeScreen();
        expect(shared.openURL).toHaveBeenCalledWith('https://example.test/oauth-login');
    }, testTimeoutMs);
});
