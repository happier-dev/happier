import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { createWelcomeFeaturesResponse } from '../index.testHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

const canOpenURL = vi.fn(async () => true);
const openURL = vi.fn(async () => true);
vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ActivityIndicator: 'ActivityIndicator',
    Linking: { canOpenURL, openURL },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: vi.fn(), back: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: vi.fn(async () => true),
        alert: vi.fn(async () => {}),
    },
}));

const setPendingExternalAuth = vi.fn(async () => true);
const clearPendingExternalAuth = vi.fn(async () => true);
vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        setPendingExternalAuth,
        clearPendingExternalAuth,
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
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

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => ({
        id: 'github',
        displayName: 'GitHub',
        getExternalSignupUrl: async () => 'https://example.test/oauth',
    }),
}));

const baseWelcomeFeatures = createWelcomeFeaturesResponse({
    signupMethods: [
        { id: 'anonymous', enabled: false },
        { id: 'github', enabled: true },
    ],
    requiredProviders: ['github'],
    autoRedirectEnabled: false,
    autoRedirectProviderId: null,
});

vi.mock('@/sync/api/capabilities/apiFeatures', () => ({
    getServerFeatures: async () => ({
        ...baseWelcomeFeatures,
        features: {
            ...baseWelcomeFeatures.features,
            auth: {
                ...baseWelcomeFeatures.features.auth,
                recovery: { providerReset: { enabled: true, providers: ['github'] } },
            },
        },
    }),
}));

function findProviderButtonAction(tree: renderer.ReactTestRenderer): () => Promise<void> | void {
    const buttons = tree.root.findAll((node) => (node.type as unknown) === 'RoundButton');
    const providerButton = buttons.find((button) => typeof button.props?.action === 'function');
    expect(providerButton).toBeTruthy();
    return providerButton!.props.action as () => Promise<void> | void;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('/restore/lost-access', () => {
    it('starts provider reset flow by setting intent=reset and opening the external signup URL', async () => {
        vi.resetModules();
        openURL.mockClear();
        canOpenURL.mockClear();
        setPendingExternalAuth.mockClear();
        clearPendingExternalAuth.mockClear();

        const { default: Screen } = await import('./lost-access');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            await act(async () => {});
            if (!tree) {
                throw new Error('Expected lost access screen renderer');
            }

            const triggerProviderReset = findProviderButtonAction(tree);
            await act(async () => {
                await triggerProviderReset();
            });

            expect(setPendingExternalAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'github', intent: 'reset' }));
            expect(canOpenURL).toHaveBeenCalledWith('https://example.test/oauth');
            expect(openURL).toHaveBeenCalledWith('https://example.test/oauth');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('blocks unsafe provider URLs and clears pending state', async () => {
        vi.resetModules();
        openURL.mockClear();
        canOpenURL.mockClear();
        setPendingExternalAuth.mockClear();
        clearPendingExternalAuth.mockClear();

        vi.doMock('@/auth/providers/registry', () => ({
            getAuthProvider: () => ({
                id: 'github',
                displayName: 'GitHub',
                getExternalSignupUrl: async () => 'javascript:alert(1)',
            }),
        }));

        const { default: Screen } = await import('./lost-access');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            await act(async () => {});
            if (!tree) {
                throw new Error('Expected lost access screen renderer');
            }

            const triggerProviderReset = findProviderButtonAction(tree);
            await act(async () => {
                await triggerProviderReset();
            });

            expect(canOpenURL).not.toHaveBeenCalled();
            expect(openURL).not.toHaveBeenCalled();
            expect(clearPendingExternalAuth).toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
