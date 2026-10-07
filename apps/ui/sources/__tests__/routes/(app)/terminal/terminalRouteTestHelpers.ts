import * as React from 'react';
import { afterAll, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

installDisconnectedServerSocketBoundary();
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));

/** Real Auth/Sync owners; HTTP and Socket transports remain external boundaries. */
export async function initializeTerminalRouteRuntimeForTests() {
    const webLocks = installWebLockManagerMock();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async () => new Response('{}', { status: 404 }));
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    afterAll(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
        webLocks.restore();
    });
}

const authenticatedCredentials: AuthCredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' };
export async function renderTerminalRoute(Screen: React.ComponentType, credentials: AuthCredentials | null = authenticatedCredentials) {
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    return renderScreen(React.createElement(InjectedAuthProvider, { credentials, children: React.createElement(Screen) }));
}

type TerminalRouteModuleFactory = () => unknown | Promise<unknown>;

type InstallTerminalRouteCommonModuleMocksOptions = Readonly<{
    reactNative?: TerminalRouteModuleFactory;
    router?: TerminalRouteModuleFactory;
    unistyles?: TerminalRouteModuleFactory;
    text?: TerminalRouteModuleFactory;
}>;

const terminalRouteModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as TerminalRouteModuleFactory | undefined,
        router: undefined as TerminalRouteModuleFactory | undefined,
        unistyles: undefined as TerminalRouteModuleFactory | undefined,
        text: undefined as TerminalRouteModuleFactory | undefined,
    },
}));

export function resetTerminalRouteTestState() {
    terminalRouteModuleState.options = {
        reactNative: undefined,
        router: undefined,
        unistyles: undefined,
        text: undefined,
    };
}

export function installTerminalRouteCommonModuleMocks(
    options: InstallTerminalRouteCommonModuleMocksOptions = {},
) {
    terminalRouteModuleState.options = {
        reactNative: options.reactNative,
        router: options.router,
        unistyles: options.unistyles,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const activeOptions = terminalRouteModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) =>
                    options.web ?? options.default ?? options.ios ?? options.android,
            },
        });
    });

    vi.mock('expo-router', async () => {
        const activeOptions = terminalRouteModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: vi.fn(),
                push: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
            params: {},
            pathname: '/terminal',
        }).module;
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = terminalRouteModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = terminalRouteModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@expo/vector-icons', async () =>
        (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

}
