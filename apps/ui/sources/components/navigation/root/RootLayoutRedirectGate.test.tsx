// @vitest-environment jsdom
import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen } from '@/dev/testkit';
import { createSignInServiceFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { BaseNavigationContainer, createNavigatorFactory, NavigationHelpersContext, StackActions, StackRouter, useNavigationBuilder } from '@react-navigation/core';

// Installed navigator logic remains real; Expo's Redirect is the SDK boundary below.
function TestNavigator(props: Readonly<{ children: React.ReactNode; layout?: (props: { children: React.ReactNode }) => React.ReactElement }>) {
    const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, props);
    return <NavigationContent>{descriptors[state.routes[state.index].key].render()}</NavigationContent>;
}
const TestStack = createNavigatorFactory(TestNavigator)();
let dispatchRedirects = false;
function NavigationRedirect() {
    // Expo routes through the registered navigator, not the parent SceneView's navigation prop.
    const navigation = React.useContext(NavigationHelpersContext);
    React.useEffect(() => { navigation?.dispatch(StackActions.replace('index')); }, [navigation]);
    return null;
}

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
    Redirect: (props: { href: string }) => dispatchRedirects ? <NavigationRedirect /> : React.createElement('Redirect', props),
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
import { RootLayoutRedirectGate, renderRootLayoutRedirectGate, WebServerOverrideGate } from './RootLayoutRedirectGate';

await initializeAuthRouteRuntimeForTests();

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
    it('mounts the exact Source setup landing on a signed-out device', async () => {
        authState.isAuthenticated = false;
        setNav('/projects/setup', ['(app)', 'projects', 'setup']);
        const screen = await renderGateScreen(<RootLayoutRedirectGate><div data-testid="source-setup" /></RootLayoutRedirectGate>);
        try {
            expect(screen.findAll(node => node.props['data-testid'] === 'source-setup')).toHaveLength(1);
            expect(screen.findAllByType('Redirect' as never)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('mounts the signed-in Artifact landing while signed out so the route can retain its transient fragment', async () => {
        authState.isAuthenticated = false;
        setNav('/share/artifact/invite', ['(app)', 'share', 'artifact', '[lookupId]']);
        const screen = await renderGateScreen(<RootLayoutRedirectGate><div data-testid="signed-artifact-landing" /></RootLayoutRedirectGate>);
        try {
            expect(screen.findAll(node => node.props['data-testid'] === 'signed-artifact-landing')).toHaveLength(1);
            expect(screen.findAllByType('Redirect' as never)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
    let locks: ReturnType<typeof installWebLockManagerMock>;
    beforeEach(() => {
        dispatchRedirects = false;
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

    it('lets the signed-out desktop opening presenter mount without redirecting to welcome', async () => {
        authState.isAuthenticated = false;
        setNav('/desktop/opening', ['(app)', 'desktop', 'opening']);
        const screen = await renderGateScreen(<RootLayoutRedirectGate><div data-testid="opening-presenter" /></RootLayoutRedirectGate>);
        try {
            expect(screen.findAll(node => node.props['data-testid'] === 'opening-presenter')).toHaveLength(1);
            expect(screen.findAllByType('Redirect' as never)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('preserves the explicit Home when redirecting a protected route to sign-in', async () => {
        authState.isAuthenticated = false;
        setNav('/settings', ['settings']);
        const serverUrl = 'https://selected-entry.example.test';
        vi.stubGlobal('window', { location: { href: `https://app.example.test/settings?server=${encodeURIComponent(serverUrl)}` } });
        const screen = await renderGateScreen(<RootLayoutRedirectGate><></></RootLayoutRedirectGate>);
        try { expect(screen.findByType('Redirect').props.href).toBe(`/?server=${encodeURIComponent(serverUrl)}`); }
        finally { await screen.unmount(); }
    });

    it('settles a signed-out first machine deep link through the registered Home navigator without mounting protected content', async () => {
        authState.isAuthenticated = false;
        dispatchRedirects = true;
        setNav('/machines/machine-a', ['(app)', 'machines', '[id]', 'index']);
        const unhandled: unknown[] = [];
        const protectedMount = vi.fn();
        function Home() { return React.createElement('HomeSurface'); }
        function Machine() { protectedMount(); return React.createElement('ProtectedMachine'); }
        function App() {
            return <TestStack.Navigator layout={renderRootLayoutRedirectGate}>
                <TestStack.Screen name="index" component={Home} />
                <TestStack.Screen name="machines/[id]/index" component={Machine} />
            </TestStack.Navigator>;
        }
        const screen = await renderGateScreen(<BaseNavigationContainer
            initialState={{ routes: [{ name: 'App', state: { routes: [{ name: 'machines/[id]/index', params: { id: 'machine-a' } }] } }] }}
            onUnhandledAction={action => unhandled.push(action)}
            onStateChange={state => {
                const app = state?.routes[state.index];
                const leaf = app?.state?.routes[app.state.index ?? 0];
                if (leaf?.name === 'index') setNav('/', ['(app)', 'index']);
            }}>
            <TestStack.Navigator><TestStack.Screen name="App" component={App} /></TestStack.Navigator>
        </BaseNavigationContainer>);
        try {
            expect(protectedMount).not.toHaveBeenCalled();
            expect(screen.findAllByType('HomeSurface' as never)).toHaveLength(1);
            expect(unhandled).toEqual([]);
        } finally { await screen.unmount(); }
    });

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

    it.each([
        { pathname: '/settings', segments: ['(app)', 'settings'] },
        { pathname: '/settings/plugins/happier.connected-accounts/accounts', segments: ['(app)', 'settings', 'plugins', '[pluginId]', '[pageId]'] },
        { pathname: '/plugins/happier.triage-board/board', segments: ['(app)', 'plugins', '[pluginId]', '[localId]'] },
    ])('redirects a signed-out cold deep link to sign-in rather than rendering a blank protected page ($pathname)', async ({ pathname, segments }) => {
        authState.isAuthenticated = false;
        setNav(pathname, segments);

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
            expect(screen.findAllByType('Redirect' as never)[0]?.props.href).toBe('/');
            expect(shell.n).toBe(0);
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the redirected Home chooser and connection draft mounted after sign-out', async () => {
        authState.isAuthenticated = false;
        setNav('/server', ['(app)', 'server']);
        const screen = await renderGateScreen(
            <RootLayoutRedirectGate><div data-testid="home-connection-screen" /></RootLayoutRedirectGate>,
        );
        try {
            for (const [pathname, segments] of [
                ['/settings/server', ['(app)', 'settings', 'server']],
                ['/settings/server/add', ['(app)', 'settings', 'server', 'add']],
                ['/settings/server/saved-home', ['(app)', 'settings', 'server', '[homeId]']],
            ] as const) {
                await act(async () => setNav(pathname, [...segments]));
                expect(screen.findByTestId('home-connection-screen')).not.toBeNull();
                expect(screen.findAllByType('Redirect' as never)).toHaveLength(0);
            }
            await act(async () => setNav('/settings/account', ['(app)', 'settings', 'account']));
            expect(screen.findByTestId('home-connection-screen')).toBeNull();
            expect(screen.findAllByType('Redirect' as never)).toHaveLength(1);
        } finally {
            await screen.unmount();
        }
    });

    it.each([
        ['index'],
        ['setup'],
        ['setup', 'index'],
        ['setup', 'wizard'],
        ['server'],
        ['settings', 'server'],
        ['settings', 'server', 'add'],
        ['settings', 'server', '[homeId]'],
        ['settings', 'server', 'device'],
        ['settings', 'server', 'groups', 'new'],
        ['settings', 'server', 'groups', '[groupId]'],
        ['terminal'],
        ['terminal', 'connect'],
        ['account'],
        ['restore'],
        ['restore', 'lost-access'],
        ['restore', 'manual'],
        ['restore', 'show-qr'],
        ['oauth', '[provider]'],
        ['oauth', 'connected-account', 'callback'],
        ['oauth', 'mcp', 'callback'],
        ['homes', 'sign-in'],
        ['join', '[token]'],
        ['teams', '[teamId]', 'sign-in'],
        ['auth', 'email', 'verify', '[token]'],
        ['auth', 'password', 'reset', '[token]'],
        ['auth', 'password', 'recover'],
        ['share', '[token]'],
        ['preview-link', '[exposureId]'],
        ['desktop', 'activity-overlay'],
        ['desktop', 'capture'],
        ['desktop', 'capture-selection'],
    ].map(segments => ({ segments, pathname: segments[0] === 'index' ? '/' : `/${segments.join('/')}` })))('mounts a signed-out public route ($pathname)', async ({ pathname, segments }) => {
        authState.isAuthenticated = false;
        setNav(pathname, ['(app)', ...segments]);

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
