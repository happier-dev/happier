import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createWelcomeFeaturesResponse } from '../index.testHelpers';
import { installRestoreRouteCommonModuleMocks, resetRestoreRouteTestState } from './restoreRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
    canOpenURL: vi.fn(async () => true),
    clearPendingExternalAuth: vi.fn(async () => true),
    getExternalAuthUrl: vi.fn(async (_params: unknown) => 'https://example.test/oauth'),
    openURL: vi.fn(async () => true),
    setPendingExternalAuth: vi.fn(async () => true),
}));

installRestoreRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: <T,>(spec: { ios?: T; default?: T }) => spec.ios ?? spec.default,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            Dimensions: {
                get: () => ({ width: 800, height: 600 }),
            },
            ScrollView: 'ScrollView',
            View: 'View',
            Text: 'Text',
            ActivityIndicator: 'ActivityIndicator',
            Linking: {
                canOpenURL: mockState.canOpenURL,
                openURL: mockState.openURL,
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { replace: vi.fn(), back: vi.fn(), push: vi.fn() },
        });
        return routerMock.module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: vi.fn(async () => true),
                alert: vi.fn(async () => {}),
            },
        }).module;
    },
});

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'http://localhost:53288',
        kind: 'custom',
        generation: 1,
    }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        setPendingExternalAuth: mockState.setPendingExternalAuth,
        clearPendingExternalAuth: mockState.clearPendingExternalAuth,
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytesAsync: async (n: number) => new Uint8Array(n).fill(9),
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: (_bytes: unknown, encoding?: 'base64' | 'base64url') => {
        if (encoding === 'base64url') return 'base64url-value';
        return 'base64-value+slash/plus+';
    },
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
        getExternalAuthUrl: mockState.getExternalAuthUrl,
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
    recoveryProviderResetEnabled: true,
    recoveryProviderResetProviders: ['github'],
});

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: async () => baseWelcomeFeatures,
}));

function findProviderButtonAction(tree: renderer.ReactTestRenderer): () => Promise<void> | void {
    const buttons = tree.findAll((node) => (node.type as unknown) === 'RoundButton');
    const providerButton = buttons.find((button) => typeof button.props?.action === 'function');
    expect(providerButton).toBeTruthy();
    return providerButton!.props.action as () => Promise<void> | void;
}

afterEach(() => {
    vi.restoreAllMocks();
    resetRestoreRouteTestState();
});

describe('/restore/lost-access', () => {
    it('starts provider reset flow by setting intent=reset and opening the external signup URL', async () => {
        vi.resetModules();
        mockState.openURL.mockClear();
        mockState.canOpenURL.mockClear();
        mockState.setPendingExternalAuth.mockClear();
        mockState.clearPendingExternalAuth.mockClear();
        mockState.getExternalAuthUrl.mockClear();

        const { default: Screen } = await import('@/app/(app)/restore/lost-access');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            tree = (await renderScreen(<Screen />)).tree;
            await flushHookEffects();
            if (!tree) {
                throw new Error('Expected lost access screen renderer');
            }

            const triggerProviderReset = findProviderButtonAction(tree);
            await act(async () => {
                await triggerProviderReset();
            });

            expect(mockState.setPendingExternalAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'github', intent: 'reset' }));
            expect(mockState.getExternalAuthUrl).toHaveBeenCalledWith(
                expect.objectContaining({ mode: 'keyed', publicKey: 'base64-value+slash/plus+' }),
            );
            expect(mockState.canOpenURL).toHaveBeenCalledWith('https://example.test/oauth');
            expect(mockState.openURL).toHaveBeenCalledWith('https://example.test/oauth');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('blocks unsafe provider URLs and clears pending state', async () => {
        vi.resetModules();
        mockState.openURL.mockClear();
        mockState.canOpenURL.mockClear();
        mockState.setPendingExternalAuth.mockClear();
        mockState.clearPendingExternalAuth.mockClear();

        vi.doMock('@/auth/providers/registry', () => ({
            getAuthProvider: () => ({
                id: 'github',
                displayName: 'GitHub',
                getExternalAuthUrl: vi.fn(async () => 'javascript:alert(1)'),
            }),
        }));

        const { default: Screen } = await import('@/app/(app)/restore/lost-access');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            tree = (await renderScreen(<Screen />)).tree;
            await flushHookEffects();
            if (!tree) {
                throw new Error('Expected lost access screen renderer');
            }

            const triggerProviderReset = findProviderButtonAction(tree);
            await act(async () => {
                await triggerProviderReset();
            });

            expect(mockState.canOpenURL).not.toHaveBeenCalled();
            expect(mockState.openURL).not.toHaveBeenCalled();
            expect(mockState.clearPendingExternalAuth).toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
