import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, createModalModuleMock, flushHookEffects, renderScreen, type RenderScreenResult } from '@/dev/testkit';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';

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

const getPendingSetupIntentMock = vi.hoisted(() => vi.fn<() => PendingSetupIntent | null>());
const setPendingSetupIntentMock = vi.hoisted(() => vi.fn<(value: PendingSetupIntent) => void>());
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    setPendingSetupIntent: (value: PendingSetupIntent) => setPendingSetupIntentMock(value),
    clearPendingSetupIntent: vi.fn(),
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return {
        ...actual,
        useIsLandscape: () => false,
    };
});

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));

const tauriDesktopState = vi.hoisted(() => ({
    value: false,
}));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (options: Record<string, unknown>) => options?.[platformState.os] ?? options?.default,
        },
    });
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
    platformState.os = 'web';
    tauriDesktopState.value = false;
    getPendingSetupIntentMock.mockReturnValue(null);
    setPendingSetupIntentMock.mockReset();
});

describe('Home external auth start', () => {
    it('redirects first-launch Tauri desktop users into /setup before showing auth actions', async () => {
        tauriDesktopState.value = true;

        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');
        getPendingSetupIntentMock.mockReturnValue(null);

        await renderScreen(<Home />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'pre_auth',
            relayUrl: 'http://api.example.test',
        });
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/setup');
    });

    it('does not redirect browser-web users into /setup by default', async () => {
        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');
        getPendingSetupIntentMock.mockReturnValue(null);

        await renderScreen(<Home />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(setPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
    });

    it('does not force mobile-native first launch through the desktop setup route', async () => {
        platformState.os = 'ios';
        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');
        getPendingSetupIntentMock.mockReturnValue(null);

        await renderScreen(<Home />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(setPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
    });

    it('opens the setup route from the welcome setup CTA on Tauri desktop', async () => {
        tauriDesktopState.value = true;

        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');

        const screen = await renderScreen(<Home />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        const button = screen.findByTestId('welcome-open-setup');
        expect(button).not.toBeNull();

        await act(async () => {
            const handler = button?.props.onPress ?? button?.props.action;
            await handler?.();
        });

        expect(expoRouterMock.spies.push).toHaveBeenCalledWith('/setup');
    });

    it('keeps the server configuration screen reachable when the selected relay is incompatible', async () => {
        const Home = await loadHome();
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'http://api.example.test',
        });
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'unsupported',
            reason: 'invalid_payload',
        });

        const screen = await renderScreen(<Home />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        const button = screen.findByTestId('welcome-change-relay');
        expect(button).not.toBeNull();

        await act(async () => {
            const handler = button?.props.onPress ?? button?.props.action;
            await handler?.();
        });

        expect(expoRouterMock.spies.push).toHaveBeenCalledWith('/settings/server');
    });

    it('uses /setup as the auth returnTo when a setup continuation is pending', async () => {
        tauriDesktopState.value = true;

        const Home = await loadHome();
        const provider = {
            id: 'github',
            getExternalAuthUrl: vi.fn(async () => 'https://oauth.example.test/auth'),
        };
        getAuthProviderMock.mockReturnValue(provider);
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        mockGithubAuthFeatures('provision', 'keyed');

        const screen = await renderScreen(<Home />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        const signupButton = findActionButton(screen, 'welcome-signup-provider');
        await act(async () => {
            await signupButton.props.action();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(tokenStorageMock.setPendingExternalAuth).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                returnTo: '/setup',
            }),
        );
    });

    it('starts keyed external provider signup with publicKey', async () => {
        const Home = await loadHome();
        const provider = {
            id: 'github',
            getExternalAuthUrl: vi.fn(async () => 'https://oauth.example.test/auth'),
        };
        getAuthProviderMock.mockReturnValue(provider);
        mockGithubAuthFeatures('provision', 'keyed');

        const screen = await renderScreen(<Home />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        const signupButton = findActionButton(screen, 'welcome-signup-provider');
        await act(async () => {
            await signupButton.props.action();
            await flushHookEffects({ cycles: 1, turns: 2 });
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
        await flushHookEffects({ cycles: 1, turns: 2 });

        const loginButton = findActionButton(screen, 'welcome-create-account');
        await act(async () => {
            await loginButton.props.action();
            await flushHookEffects({ cycles: 1, turns: 2 });
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
