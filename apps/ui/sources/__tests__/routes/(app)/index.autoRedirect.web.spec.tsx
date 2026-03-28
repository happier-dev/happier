import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createWelcomeFeaturesResponse, renderWelcomeScreen } from './index.testHelpers';
import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
    clearPendingExternalAuthMock: vi.fn(async () => true),
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
                                useWindowDimensions: () => ({ width: 400, height: 800, scale: 1, fontScale: 1 }),
                                AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
                                Platform: {
                                    OS: 'web',
                                    select: (spec: Record<string, unknown>) => (spec && Object.prototype.hasOwnProperty.call(spec, 'web') ? spec.web : undefined),
                                },
                                Linking: { openURL: mockState.openURL },
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

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverUrl: '' }),
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
        getAuthAutoRedirectSuppressedUntil: () => mockState.getSuppressedUntilMock(),
        setPendingExternalAuth: () => mockState.setPendingExternalAuthMock(),
        clearPendingExternalAuth: () => mockState.clearPendingExternalAuthMock(),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => ({
        id: 'github',
        displayName: 'GitHub',
        getExternalAuthUrl: async () => mockState.externalSignupUrl,
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

describe('/ (welcome) auto redirect on web', () => {
    const testTimeoutMs = 60_000;

    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        mockState.openURL.mockClear();
        getServerFeaturesMock.mockClear();
        getServerFeaturesSnapshotMock.mockClear();
        mockState.setPendingExternalAuthMock.mockClear();
        mockState.clearPendingExternalAuthMock.mockClear();
        mockState.getSuppressedUntilMock.mockReset();
        mockState.getSuppressedUntilMock.mockResolvedValue(0);
        mockState.externalSignupUrl = 'https://example.test/oauth';
    });

    it('navigates in the current tab on web to avoid popup-blocker failures', async () => {
        vi.resetModules();

        const assign = vi.fn();
        const originalWindow = (globalThis as any).window;
        (globalThis as any).window = { location: { assign } };

        try {
            await renderWelcomeScreen();
            expect(assign).toHaveBeenCalledWith('https://example.test/oauth');
            expect(mockState.openURL).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).window = originalWindow;
        }
    });

});
