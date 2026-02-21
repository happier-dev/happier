import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { createWelcomeFeaturesResponse } from './index.testHelpers';
import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));
vi.mock('@/components/navigation/shell/HomeHeader', () => ({ HomeHeaderNotAuth: () => null }));
vi.mock('@/components/navigation/shell/MainView', () => ({ MainView: () => null }));
vi.mock('@/components/ui/buttons/RoundButton', () => ({ RoundButton: () => null }));
vi.mock('@shopify/react-native-skia', () => ({}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const openURL = vi.fn(async () => true);
let externalSignupUrl = 'https://example.test/oauth';
const getSuppressedUntilMock = vi.fn(async () => 0);
const setPendingExternalAuthMock = vi.fn(async () => true);
const clearPendingExternalAuthMock = vi.fn(async () => true);

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Text: 'Text',
    View: 'View',
    Image: 'Image',
    useWindowDimensions: () => ({ width: 400, height: 800, scale: 1, fontScale: 1 }),
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    Platform: {
        OS: 'ios',
        select: (spec: Record<string, unknown>) => (spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? spec.ios : undefined),
    },
    Linking: { openURL },
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
        getAuthAutoRedirectSuppressedUntil: () => getSuppressedUntilMock(),
        setPendingExternalAuth: () => setPendingExternalAuthMock(),
        clearPendingExternalAuth: () => clearPendingExternalAuthMock(),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => ({
        id: 'github',
        displayName: 'GitHub',
        getExternalSignupUrl: async () => externalSignupUrl,
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

describe('/ (welcome) auto redirect', () => {
    beforeEach(() => {
        openURL.mockClear();
        getServerFeaturesMock.mockClear();
        getServerFeaturesSnapshotMock.mockClear();
        setPendingExternalAuthMock.mockClear();
        clearPendingExternalAuthMock.mockClear();
        getSuppressedUntilMock.mockReset();
        getSuppressedUntilMock.mockResolvedValue(0);
        externalSignupUrl = 'https://example.test/oauth';
    });

    async function renderWelcomeScreen(): Promise<void> {
        const { default: Screen } = await import('./index');
        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            await act(async () => {});
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    }

    it('auto-starts provider signup when server enables auth.ui.autoRedirect', async () => {
        vi.resetModules();
        await renderWelcomeScreen();
        expect(openURL).toHaveBeenCalledWith('https://example.test/oauth');
    });

    it('does not double-trigger auto-redirect when the effect runs twice before suppression is resolved', async () => {
        vi.resetModules();

        let resolveSuppressedUntil: ((value: number) => void) | undefined;
        const suppressedUntilPromise = new Promise<number>((resolve) => {
            resolveSuppressedUntil = resolve;
        });
        getSuppressedUntilMock.mockImplementationOnce(async () => await suppressedUntilPromise);

        const { default: Screen } = await import('./index');
        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(
                    <React.StrictMode>
                        <Screen />
                    </React.StrictMode>,
                );
            });

            expect(openURL).not.toHaveBeenCalled();

            resolveSuppressedUntil?.(0);
            await act(async () => {});

            expect(openURL).toHaveBeenCalledTimes(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('does not auto-start provider signup when auto-redirect is temporarily suppressed', async () => {
        vi.resetModules();
        getSuppressedUntilMock.mockResolvedValue(Date.now() + 60_000);

        await renderWelcomeScreen();
        expect(openURL).not.toHaveBeenCalled();
    });

    it('does not throw when server features fetch fails', async () => {
        vi.resetModules();
        getServerFeaturesMock.mockRejectedValueOnce(new Error('network'));
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({ status: 'error', reason: 'network' });

        await renderWelcomeScreen();
        expect(openURL).not.toHaveBeenCalled();
    });

    it('refuses unsafe external signup URLs', async () => {
        vi.resetModules();
        externalSignupUrl = 'javascript:alert(1)';
        await renderWelcomeScreen();
        expect(openURL).not.toHaveBeenCalled();
    });
});
