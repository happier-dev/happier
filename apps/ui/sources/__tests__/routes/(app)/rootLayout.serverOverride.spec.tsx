// @vitest-environment jsdom

import * as React from 'react';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { getPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { initializeRootLayoutRuntimeForTests, renderRootLayoutRoute, installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;


let historyReplaceStateSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

function installWebLocation(params: Readonly<{ href: string }>) {
    const browserWindow = window;
    const locationState = {
        href: params.href,
        pathname: new URL(params.href).pathname,
        search: new URL(params.href).search,
        hash: new URL(params.href).hash,
        reload: vi.fn(),
    };
    historyReplaceStateSpy = vi.fn((_data: unknown, _title: string, nextUrl?: string | URL | null) => {
        if (typeof nextUrl !== 'string' && !(nextUrl instanceof URL)) return;
        const resolved = new URL(nextUrl.toString(), locationState.href);
        locationState.href = resolved.toString();
        locationState.pathname = resolved.pathname;
        locationState.search = resolved.search;
        locationState.hash = resolved.hash;
    });

    vi.stubGlobal('window', {
        location: locationState,
        history: { replaceState: historyReplaceStateSpy },
        addEventListener: browserWindow.addEventListener.bind(browserWindow),
        removeEventListener: browserWindow.removeEventListener.bind(browserWindow),
    });

    return { historyReplaceStateSpy };
}

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

installRootLayoutRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/',
            segments: ['(app)'],
            router: {
                push: routerPushSpy,
                replace: routerReplaceSpy,
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(choices: { web?: T; default?: T }) => choices?.web ?? choices?.default,
            },
            AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: { colors: { surface: '#fff', header: { background: '#fff', tint: '#000' } } },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
});

await initializeRootLayoutRuntimeForTests();

afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    historyReplaceStateSpy.mockReset();
    routerPushSpy.mockReset();
    routerReplaceSpy.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// Collect the real route graph before the test deadline, without weakening it.
const RootLayout = (await import('@/app/(app)/_layout')).default;
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const Home = (await import('@/app/(app)/index')).Home;
function RootAndHome() {
    return React.createElement(AppPaneProvider, null, React.createElement(RootLayout), React.createElement(Home));
}

async function renderRootLayout() {
    await renderRootLayoutRoute(RootAndHome, connection?.credentials);
    await flushHookEffects();
}

describe('App RootLayout server override', () => {

    it('does not switch servers for loopback-equivalent pending terminal connects', async () => {
        installWebLocation({
            href: 'https://app.example.test/',
        });
        connection = await restoreServerAccountForTest({ serverUrl: 'http://localhost:53288',
            serverIdentityId: 'srv_home_local',
            request: async input => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
                ? Response.json(createPlainAccountEncryptionCurrentnessFixture()) : new Response('{}', { status: 404 }),
        });
        setPendingTerminalConnect({
            publicKeyB64Url: 'abc123',
            serverUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
            serverIdentityId: 'srv_home_local',
        });
        expect(getPendingTerminalConnect()).toEqual({ publicKeyB64Url: 'abc123',
            serverUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288', serverIdentityId: 'srv_home_local' });

        await renderRootLayout();

        expect(getActiveServerSnapshot().serverUrl).toBe('http://localhost:53288');
        await vi.waitFor(() => expect(routerReplaceSpy.mock.calls).toEqual([['/terminal/connect']]));
    });
});
