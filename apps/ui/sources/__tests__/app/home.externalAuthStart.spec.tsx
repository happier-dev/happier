import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    router: { push: vi.fn(), replace: vi.fn() },
}));

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

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), confirm: vi.fn(async () => true) },
}));

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
                                actions: [{ id: 'provision', enabled: true, mode: 'keyed' }],
                            },
                        ],
                    },
                },
            },
        });

        let tree: ReactTestRenderer | null = null;
        act(() => {
            tree = create(<Home />);
        });

        try {
            await act(async () => {
                await flushEffects();
            });

            const signupButton = tree!.root.findByProps({ testID: 'welcome-signup-provider' });
            await act(async () => {
                await signupButton.props.action();
                await flushEffects();
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
        }

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
                                actions: [{ id: 'login', enabled: true, mode: 'keyless' }],
                            },
                        ],
                    },
                },
            },
        });

        let tree: ReactTestRenderer | null = null;
        act(() => {
            tree = create(<Home />);
        });

        try {
            await act(async () => {
                await flushEffects();
            });

            const loginButton = tree!.root.findByProps({ testID: 'welcome-create-account' });
            await act(async () => {
                await loginButton.props.action();
                await flushEffects();
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
        }

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
