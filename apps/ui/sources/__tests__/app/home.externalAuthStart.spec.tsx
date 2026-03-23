import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, createModalModuleMock, renderScreen, type RenderScreenResult } from '@/dev/testkit';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));

const expoRouterMock = createExpoRouterMock({
    router: { push: vi.fn(), replace: vi.fn() },
});
vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: false,
        login: vi.fn(),
        loginWithCredentials: vi.fn(),
        credentials: null,
    }),
}));

const getServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: (...args: any[]) => getServerFeaturesSnapshotMock(...args),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return {
        ...actual,
        useIsLandscape: () => false,
    };
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const getAuthProviderMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: (id: string) => getAuthProviderMock(id),
}));

const tokenStorageMock = vi.hoisted(() => ({
    setPendingExternalAuth: vi.fn(async () => true),
    clearPendingExternalAuth: vi.fn(async () => undefined),
    getAuthAutoRedirectSuppressedUntil: vi.fn(async () => 0),
}));
vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: tokenStorageMock,
}));

vi.mock('@/auth/providers/externalAuthUrl', () => ({
    isSafeExternalAuthUrl: () => true,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverUrl: 'http://api.example.test' }),
}));

vi.mock('@/track', () => ({
    trackAccountCreated: vi.fn(),
    trackAccountRestored: vi.fn(),
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: () => null,
}));

const modalMock = createModalModuleMock({
    spies: {
        alert: vi.fn(),
        confirm: vi.fn(async () => true),
    },
});
vi.mock('@/modal', () => modalMock.module);

const fireAndForgetPromises = vi.hoisted(() => [] as Promise<any>[]);
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<any>) => {
        fireAndForgetPromises.push(promise);
    },
}));

vi.mock('@/utils/errors/formatOperationFailedDebugMessage', () => ({
    formatOperationFailedDebugMessage: (fallback: string) => fallback,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytesAsync: async (size: number) => new Uint8Array(size).fill(1),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function loadHome() {
    const mod = await import('@/app/(app)/index');
    return mod.default;
}

async function flushEffects() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.allSettled(fireAndForgetPromises.splice(0));
}

function findActionButton(screen: RenderScreenResult, testID: string) {
    const button = screen.findAllByTestId(testID).find((node) => typeof node.props.action === 'function');
    if (!button) {
        throw new Error(`Unable to find action button "${testID}"`);
    }
    return button;
}

function mockGithubAuthFeatures(action: 'provision' | 'login', mode: 'keyed' | 'keyless') {
    getServerFeaturesSnapshotMock.mockResolvedValue({
        status: 'ready',
        features: {
            capabilities: {
                oauth: {
                    providers: {
                        github: { configured: true },
                    },
                },
                auth: {
                    methods: [
                        {
                            id: 'github',
                            actions: [{ id: action, enabled: true, mode }],
                        },
                    ],
                },
            },
        },
    });
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('Home external auth start', () => {
    it('starts keyed external provider signup with publicKey', async () => {
        const Home = await loadHome();
        const provider = {
            id: 'github',
            getExternalAuthUrl: vi.fn(async () => 'https://oauth.example.test/auth'),
        };
        getAuthProviderMock.mockReturnValue(provider);
        mockGithubAuthFeatures('provision', 'keyed');

        const screen = await renderScreen(<Home />);
        await act(async () => {
            await flushEffects();
        });

        const signupButton = findActionButton(screen, 'welcome-signup-provider');
        await act(async () => {
            await signupButton.props.action();
            await flushEffects();
        });

        expect(tokenStorageMock.setPendingExternalAuth).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                proof: expect.any(String),
                secret: expect.any(String),
            }),
        );
        expect(provider.getExternalAuthUrl).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: 'keyed',
                proofHash: expect.any(String),
                publicKey: expect.any(String),
            }),
        );

    });

    it('starts keyless external login with mode=keyless proofHash', async () => {
        const Home = await loadHome();
        const provider = {
            id: 'github',
            getExternalAuthUrl: vi.fn(async () => 'https://oauth.example.test/auth'),
        };
        getAuthProviderMock.mockReturnValue(provider);
        mockGithubAuthFeatures('login', 'keyless');

        const screen = await renderScreen(<Home />);
        await act(async () => {
            await flushEffects();
        });

        const loginButton = findActionButton(screen, 'welcome-create-account');
        await act(async () => {
            await loginButton.props.action();
            await flushEffects();
        });

        expect(tokenStorageMock.setPendingExternalAuth).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                proof: expect.any(String),
            }),
        );
        expect(provider.getExternalAuthUrl).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: 'keyless',
                proofHash: expect.any(String),
            }),
        );

    });
});
