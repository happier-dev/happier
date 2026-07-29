import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

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

vi.mock('expo-router', () => ({
    Redirect: (props: Record<string, unknown>) => React.createElement('Redirect', props),
    useSegments: () => useSyncExternalStore(subscribeNav, () => navState.segments),
    usePathname: () => useSyncExternalStore(subscribeNav, () => navState.pathname),
    useGlobalSearchParams: () => ({}),
    useRouter: () => ({ push() {}, back() {}, replace() {}, setParams() {} }),
    router: { push() {}, back() {}, replace() {}, setParams() {} },
}));

const authState: { isAuthenticated: boolean; refreshFromActiveServer: () => Promise<void> } = {
    isAuthenticated: true,
    refreshFromActiveServer: async () => {},
};
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

// Auth-recovery + web-server-override gating dependencies default to pass-through
// (no hold, no redirect) so the isolation property can be observed in isolation.
vi.mock('@/hooks/session/sessionRouteAuthRecovery', () => ({
    resolveSessionRouteAuthRecoveryState: () => ({ isAuthRecovering: false, baseHref: null }),
    isSessionRouteInAuthRecoverySubtree: () => false,
    shouldNormalizeSessionRouteToAuthRecoveryBase: () => false,
}));
vi.mock('@/sync/domains/state/storage', () => ({
    useEndpointConnectivity: () => ({ status: 'connected' }),
    useSyncError: () => null,
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: '', serverUrl: '', activeLocalRelayUrl: null }),
}));
vi.mock('@/sync/domains/server/url/shouldHoldAuthenticatedShellForWebServerOverride', () => ({
    shouldHoldAuthenticatedShellForWebServerOverride: () => false,
}));
vi.mock('@/sync/domains/server/url/resolveAuthenticatedWebServerUrlOverrideAction', () => ({
    resolveAuthenticatedWebServerUrlOverrideAction: () => ({ kind: 'none' as const }),
}));
vi.mock('@/sync/domains/server/url/bootstrapActiveServerFromWebLocation', () => ({
    bootstrapActiveServerFromWebLocation: () => null,
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string | null) => value ?? null,
    upsertActivateAndSwitchServer: vi.fn(async () => {}),
}));

import { useSegments } from 'expo-router';
import { RootLayoutRedirectGate } from './RootLayoutRedirectGate';

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
    beforeEach(() => {
        authState.isAuthenticated = true;
        navState.listeners.clear();
        navState.pathname = '/';
        navState.segments = [];
    });

    it('does not re-render its children (Stack subtree) on a pathname/segments-only change', async () => {
        authState.isAuthenticated = true;
        setNav('/', ['index']);

        const shell: Counter = { n: 0 };
        const nav: Counter = { n: 0 };
        const stableChild = React.createElement(ShellProbe, { counter: shell });

        const screen = await renderScreen(
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

    it('renders a redirect (and not its children) when unauthenticated on a protected route', async () => {
        authState.isAuthenticated = false;
        setNav('/settings', ['(app)', 'settings']);

        const shell: Counter = { n: 0 };
        const screen = await renderScreen(
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
        const screen = await renderScreen(
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
});
