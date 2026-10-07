// @vitest-environment jsdom
import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen } from '@/dev/testkit';
import { createSignInServiceFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { initializeTerminalRouteRuntimeForTests } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';

// Controllable navigation store so that only components calling the navigation hooks
// (via useSyncExternalStore) re-render when the route changes — faithfully modelling
// how expo-router's usePathname/useSegments subscribe the calling component in the app.
const navState: { pathname: string; segments: string[]; listeners: Set<() => void> } = {
    pathname: '/',
    segments: [],
    listeners: new Set(),
};

function subscribeNav(callback: () => void): () => void {
    navState.listeners.add(callback);
    return () => navState.listeners.delete(callback);
}

function setNav(pathname: string, segments: string[]): void {
    navState.pathname = pathname;
    navState.segments = segments;
    navState.listeners.forEach((listener) => listener());
}

vi.mock('expo-router', async () => ({
    ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        params: {}, router: { replace: replaceSpy },
    }).module,
    useSegments: () => useSyncExternalStore(subscribeNav, () => navState.segments),
    usePathname: () => useSyncExternalStore(subscribeNav, () => navState.pathname),
}));

const replaceSpy = vi.hoisted(() => vi.fn());

const authState = {
    isAuthenticated: true,
};
const runtimeFetchSpy = vi.hoisted(() => vi.fn(async () => new Response('', { status: 503 })));
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: runtimeFetchSpy,
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: false }).module;
});

import { useSegments } from 'expo-router';
import { RootLayoutRedirectGate, WebServerOverrideGate } from './RootLayoutRedirectGate';

await initializeTerminalRouteRuntimeForTests();

function renderGateScreen(children: React.ReactNode) {
    const credentials = authState.isAuthenticated ? { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' } : null;
    return renderScreen(<InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>);
}

type Counter = { n: number };

function ShellProbe({ counter }: { counter: Counter }): null {
    counter.n += 1;
    return null;
}

function NavProbe({ counter }: { counter: Counter }): null {
    useSegments();
    counter.n += 1;
    return null;
}

describe('RootLayoutRedirectGate', () => {
    let locks: ReturnType<typeof installWebLockManagerMock>;
    beforeEach(() => {
        authState.isAuthenticated = true;
        replaceSpy.mockClear();
        runtimeFetchSpy.mockClear();
        vi.unstubAllGlobals();
        locks = installWebLockManagerMock();
        navState.listeners.clear();
        navState.pathname = '/';
        navState.segments = [];
    });

    afterEach(() => { locks.restore(); });

    it('does not re-render its children (Stack subtree) on a pathname/segments-only change', async () => {
        authState.isAuthenticated = true;
        setNav('/', ['index']);

        const shell: Counter = { n: 0 };
        const nav: Counter = { n: 0 };
        const stableChild = React.createElement(ShellProbe, { counter: shell });

        const screen = await renderGateScreen(
            React.createElement(
                React.Fragment,
                null,
                React.createElement(NavProbe, { counter: nav }),
                React.createElement(RootLayoutRedirectGate, null, stableChild),
            ),
        );

        try {
            expect(shell.n).toBe(1);
            const navBefore = nav.n;

            await act(async () => {
                setNav('/settings', ['(app)', 'settings']);
            });

            // The navigation consumer re-rendered (proving the route change propagated)…
            expect(nav.n).toBe(navBefore + 1);
            // …but the gate preserved its stable child element, so the Stack subtree did NOT re-render.
            expect(shell.n).toBe(1);
        } finally {
            await screen.unmount();
        }
    });

    it('does not mutate the active server when the gate mounts without a URL override', async () => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
        const before = getActiveServerSnapshot().serverId;
        const screen = await renderGateScreen(
            React.createElement(
                RootLayoutRedirectGate,
                null,
                React.createElement(React.Fragment, null),
            ),
        );

        try {
            expect(getActiveServerSnapshot().serverId).toBe(before);
        } finally {
            await screen.unmount();
        }
    });

    it('renders a redirect (and not its children) when unauthenticated on a protected route', async () => {
        authState.isAuthenticated = false;
        setNav('/settings', ['(app)', 'settings']);

        const shell: Counter = { n: 0 };
        const screen = await renderGateScreen(
            React.createElement(
                RootLayoutRedirectGate,
                null,
                React.createElement(ShellProbe, { counter: shell }),
            ),
        );

        try {
            expect(screen.findAllByType('Redirect' as never).length).toBe(1);
            expect(shell.n).toBe(0);
        } finally {
            await screen.unmount();
        }
    });

    it('renders its children when unauthenticated on a public route', async () => {
        authState.isAuthenticated = false;
        setNav('/', ['index']);

        const shell: Counter = { n: 0 };
        const screen = await renderGateScreen(
            React.createElement(
                RootLayoutRedirectGate,
                null,
                React.createElement(ShellProbe, { counter: shell }),
            ),
        );

        try {
            expect(screen.findAllByType('Redirect' as never).length).toBe(0);
            expect(shell.n).toBe(1);
        } finally {
            await screen.unmount();
        }
    });

    it('keeps a supplied unsaved Home URL out of the switch path when reachability fails', async () => {
        const { getActiveServerSnapshot, listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
        vi.stubGlobal('window', {
            location: { href: 'https://app.example.test/session/new?server=https%3A%2F%2Funreachable.example.test' },
            history: { replaceState: vi.fn() },
        });
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://saved.example.test', source: 'manual', scope: 'device' });
        const activeBefore = getActiveServerSnapshot().serverId;
        const screen = await renderGateScreen(
            <WebServerOverrideGate><RootLayoutRedirectGate><React.Fragment /></RootLayoutRedirectGate></WebServerOverrideGate>,
        );
        try {
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
            expect(runtimeFetchSpy).toHaveBeenCalledWith('https://unreachable.example.test/health', expect.any(Object));
            expect(listServerProfiles().some((profile) => profile.serverUrl === 'https://unreachable.example.test')).toBe(false);
            expect(getActiveServerSnapshot().serverId).toBe(activeBefore);
            expect(replaceSpy).toHaveBeenCalledWith('/settings/server/add?address=https%3A%2F%2Funreachable.example.test&source=url');
        } finally {
            await screen.unmount();
        }
    });

    it('adopts a supplied Directory-capable Home without replacing the selected sign-in service', async () => {
        const address = 'https://accounts.example.test';
        runtimeFetchSpy.mockImplementation(async (...args: unknown[]) => {
            const url = String(args[0]);
            return new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok' } : createSignInServiceFeaturesResponse(address)), {
                status: url.endsWith('/health') || url.endsWith('/v1/features') ? 200 : 404, headers: { 'content-type': 'application/json' },
            });
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        vi.stubGlobal('window', {
            location: { href: `https://app.example.test/?server=${encodeURIComponent(address)}` },
            history: { replaceState: vi.fn() },
        });
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://saved.example.test', source: 'manual', scope: 'device' });
        const beforeService = profiles.resolveSelectedAccountServiceEndpoint();
        const screen = await renderGateScreen(<WebServerOverrideGate><React.Fragment /></WebServerOverrideGate>);
        try {
            await vi.waitFor(() => expect(profiles.getActiveServerSnapshot().serverUrl).toBe(address));
            expect(profiles.resolveSelectedAccountServiceEndpoint()).toEqual(beforeService);
            expect(profiles.listServerProfiles().some((profile) => profile.serverUrl === address)).toBe(true);
            expect(replaceSpy).not.toHaveBeenCalledWith(expect.stringContaining('path=other_service'));
        } finally { await screen.unmount(); }
    });
});
