import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createDeferred,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;


let historyReplaceStateSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();

const upsertActivateAndSwitchServerSpy = vi.fn(async (_params: { serverUrl: string; source: string; scope: string; refreshAuth: unknown }) => true);
const refreshFromActiveServerSpy = vi.fn(async () => {});
let isAuthenticated = true;
let activeServerUrl = 'https://api.happier.dev';
let pendingTerminalConnect: Readonly<{ publicKeyB64Url: string; serverUrl: string }> | null = null;
let exitDemoForCleanup: (() => void) | null = null;
let endJourneyForCleanup: (() => void) | null = null;

async function beginJourneyDemo(): Promise<void> {
    const [demoMode, journeySession] = await Promise.all([
        import('@/demoMode/runtime/enterExitDemoMode'),
        import('@/components/onboarding/tour/state/journeySession'),
    ]);
    demoMode.enterDemoMode();
    journeySession.beginOnboardingJourneySession();
    exitDemoForCleanup = demoMode.exitDemoMode;
    endJourneyForCleanup = journeySession.endOnboardingJourneySession;
}

function installWebLocation(params: Readonly<{ href: string }>) {
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

    (globalThis as any).document = {};
    (globalThis as any).window = {
        location: locationState,
        history: { replaceState: historyReplaceStateSpy },
    };

    return { historyReplaceStateSpy };
}

vi.mock('expo-updates', () => ({
    checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false })),
    fetchUpdateAsync: vi.fn(async () => ({})),
    reloadAsync: vi.fn(async () => {}),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

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

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated, refreshFromActiveServer: refreshFromActiveServerSpy }),
}));

vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => true,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: true }),
}));

vi.mock('@/hooks/inbox/useUpdates', () => ({
    useUpdates: () => ({
        updateAvailable: false,
        isChecking: false,
        checkForUpdates: vi.fn(async () => {}),
        reloadApp: vi.fn(async () => {}),
    }),
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/utils/path/routeUtils', () => ({
    coerceRelativeRoute: (value: string) => value,
}));

vi.mock('@/components/navigation/Header', () => ({
    createHeader: () => null,
}));

vi.mock('@/components/appShell/runtime/AuthenticatedAppRuntimeMounts', () => ({
    AuthenticatedAppRuntimeMounts: () => null,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => pendingTerminalConnect,
}));

vi.mock('@/sync/domains/pending/pendingNotificationNav', () => ({
    getPendingNotificationNav: () => null,
    clearPendingNotificationNav: vi.fn(),
    setPendingNotificationNav: vi.fn(),
}));

vi.mock('@/sync/domains/pending/pendingNotificationAction', () => ({
    getPendingNotificationAction: () => null,
    clearPendingNotificationAction: vi.fn(),
    setPendingNotificationAction: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/server/serverProfiles')>('@/sync/domains/server/serverProfiles');
    return {
        ...actual,
        getActiveServerUrl: () => activeServerUrl,
        getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: activeServerUrl, generation: 1 }),
        listServerProfiles: () => [],
    };
});

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: upsertActivateAndSwitchServerSpy,
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: async () => null,
}));

afterEach(() => {
    standardCleanup();
    exitDemoForCleanup?.();
    endJourneyForCleanup?.();
    exitDemoForCleanup = null;
    endJourneyForCleanup = null;
    isAuthenticated = true;
    activeServerUrl = 'https://api.happier.dev';
    historyReplaceStateSpy.mockReset();
    routerPushSpy.mockReset();
    routerReplaceSpy.mockReset();
    upsertActivateAndSwitchServerSpy.mockReset();
    refreshFromActiveServerSpy.mockReset();
    pendingTerminalConnect = null;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    vi.restoreAllMocks();
    vi.resetModules();
});

async function renderRootLayout() {
    const RootLayout = (await import('@/app/(app)/_layout')).default;
    await renderScreen(React.createElement(RootLayout));
    await flushHookEffects();
}

describe('App RootLayout server override', () => {
    it('keeps the journey mounted and defers the authenticated override switch while that journey owns the demo server', async () => {
        installWebLocation({
            href: 'https://app.example.test/?server=http%3A%2F%2Flocalhost%3A53288',
        });
        activeServerUrl = 'http://127.0.0.1:4099';
        isAuthenticated = false;
        await beginJourneyDemo();
        const switchDeferred = createDeferred<boolean>();
        upsertActivateAndSwitchServerSpy.mockImplementationOnce(async () => switchDeferred.promise);
        const lifecycle = { mounts: 0, unmounts: 0 };

        function JourneyProbe(): React.ReactElement {
            React.useEffect(() => {
                lifecycle.mounts += 1;
                return () => {
                    lifecycle.unmounts += 1;
                };
            }, []);
            return React.createElement('JourneyProbe');
        }

        const { RootLayoutRedirectGate } = await import('@/components/navigation/root/RootLayoutRedirectGate');
        const renderGate = () => React.createElement(
            RootLayoutRedirectGate,
            null,
            React.createElement(JourneyProbe),
        );
        const screen = await renderScreen(renderGate());
        await flushHookEffects();

        isAuthenticated = true;
        await screen.update(renderGate());
        await flushHookEffects();

        expect.soft(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect.soft(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
        expect.soft(screen.findAllByType('JourneyProbe' as never)).toHaveLength(1);

        await act(async () => {
            switchDeferred.resolve(true);
            await switchDeferred.promise;
        });
    });

    it('commits same-server override cleanup after demo teardown without unmounting the still-active journey', async () => {
        installWebLocation({
            href: 'https://app.example.test/?server=http%3A%2F%2Flocalhost%3A53288',
        });
        activeServerUrl = 'http://127.0.0.1:4099';
        isAuthenticated = false;
        await beginJourneyDemo();
        const lifecycle = { mounts: 0, unmounts: 0 };

        function JourneyProbe(): React.ReactElement {
            React.useEffect(() => {
                lifecycle.mounts += 1;
                return () => {
                    lifecycle.unmounts += 1;
                };
            }, []);
            return React.createElement('JourneyProbe');
        }

        const { RootLayoutRedirectGate } = await import('@/components/navigation/root/RootLayoutRedirectGate');
        const renderGate = () => React.createElement(
            RootLayoutRedirectGate,
            null,
            React.createElement(JourneyProbe),
        );
        const screen = await renderScreen(renderGate());
        await flushHookEffects();

        isAuthenticated = true;
        await screen.update(renderGate());
        await flushHookEffects();
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();

        activeServerUrl = 'http://localhost:53288';
        exitDemoForCleanup?.();
        exitDemoForCleanup = null;
        await screen.update(renderGate());
        await flushHookEffects();

        expect(refreshFromActiveServerSpy).toHaveBeenCalledTimes(1);
        expect(historyReplaceStateSpy).toHaveBeenCalledWith(null, '', '/');
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
        expect(screen.findAllByType('JourneyProbe' as never)).toHaveLength(1);
    });

    it('still applies an ordinary authenticated cross-server override outside a journey demo', async () => {
        installWebLocation({
            href: 'https://app.example.test/?server=https%3A%2F%2Fstack.example.test',
        });
        activeServerUrl = 'https://api.happier.dev';
        isAuthenticated = false;
        const switchDeferred = createDeferred<boolean>();
        upsertActivateAndSwitchServerSpy.mockImplementationOnce(async () => switchDeferred.promise);

        const { RootLayoutRedirectGate } = await import('@/components/navigation/root/RootLayoutRedirectGate');
        const renderGate = () => React.createElement(
            RootLayoutRedirectGate,
            null,
            React.createElement('ProtectedShell'),
        );
        const screen = await renderScreen(renderGate());
        await flushHookEffects();

        isAuthenticated = true;
        await screen.update(renderGate());
        await flushHookEffects();

        expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://stack.example.test',
            source: 'url',
            scope: 'device',
        }));
        expect(screen.findAllByType('ProtectedShell' as never)).toHaveLength(0);

        await act(async () => {
            switchDeferred.resolve(true);
            await switchDeferred.promise;
        });
    });

    it('renders safely when `?server=` is present on web routes', async () => {
        // Minimal web globals: enough for readServerUrlOverrideFromWebLocation().
        const { historyReplaceStateSpy } = installWebLocation({
            href: 'https://app.example.test/?server=https%3A%2F%2Fstack.example.test',
        });

        await renderRootLayout();
        expect(historyReplaceStateSpy.mock.calls.length).toBeGreaterThanOrEqual(0);
    });

    it('normalizes legacy `?url=...&auto=1` into the same device-scoped server override flow', async () => {
        installWebLocation({
            href: 'https://app.example.test/server?url=https%3A%2F%2Fstack.example.test&auto=1',
        });

        const { resolveAuthenticatedWebServerUrlOverrideAction } = await import('@/sync/domains/server/url/resolveAuthenticatedWebServerUrlOverrideAction');

        expect(resolveAuthenticatedWebServerUrlOverrideAction({
            isAuthenticated: true,
            bootstrappedServerUrl: null,
        })).toEqual({
            kind: 'switch_server',
            serverUrl: 'https://stack.example.test',
            cleanedRelativeUrl: '/server',
        });
    });

    it('refreshes auth instead of switching servers when the override is loopback-equivalent to the active server', async () => {
        installWebLocation({
            href: 'https://app.example.test/?server=http%3A%2F%2Fhappier-repo-dev-a1cc5e0671.localhost%3A53288',
        });
        activeServerUrl = 'http://localhost:53288';

        const { resolveAuthenticatedWebServerUrlOverrideAction } = await import('@/sync/domains/server/url/resolveAuthenticatedWebServerUrlOverrideAction');

        expect(resolveAuthenticatedWebServerUrlOverrideAction({
            isAuthenticated: true,
            bootstrappedServerUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
        })).toEqual({
            kind: 'refresh_auth',
            cleanedRelativeUrl: '/',
        });
    });

    it('holds the authenticated shell while a cross-server override switch is still resolving', async () => {
        installWebLocation({
            href: 'https://app.example.test/?server=https%3A%2F%2Fstack.example.test',
        });
        activeServerUrl = 'https://api.happier.dev';

        const { shouldHoldAuthenticatedShellForWebServerOverride } = await import('@/sync/domains/server/url/shouldHoldAuthenticatedShellForWebServerOverride');

        expect(shouldHoldAuthenticatedShellForWebServerOverride(true)).toBe(true);
        expect(shouldHoldAuthenticatedShellForWebServerOverride(false)).toBe(false);
    });

    it('does not hold the authenticated shell for loopback-equivalent same-server overrides', async () => {
        installWebLocation({
            href: 'https://app.example.test/?server=http%3A%2F%2F127.0.0.1%3A3012',
        });
        activeServerUrl = 'http://localhost:3012';

        const { shouldHoldAuthenticatedShellForWebServerOverride } = await import('@/sync/domains/server/url/shouldHoldAuthenticatedShellForWebServerOverride');

        expect(shouldHoldAuthenticatedShellForWebServerOverride(true)).toBe(false);
    });

    it('does not hold the unauthenticated shell for loopback-equivalent same-server overrides', async () => {
        installWebLocation({
            href: 'https://app.example.test/?server=http%3A%2F%2Fhappier-repo-dev-a1cc5e0671.localhost%3A53288',
        });

        const { shouldHoldUnauthenticatedShellForWebServerOverride } = await import('@/sync/domains/server/url/shouldHoldUnauthenticatedShellForWebServerOverride');

        expect(shouldHoldUnauthenticatedShellForWebServerOverride(false, 'http://localhost:53288')).toBe(false);
    });

    it('does not switch servers for loopback-equivalent pending terminal connects', async () => {
        installWebLocation({
            href: 'https://app.example.test/',
        });
        activeServerUrl = 'http://localhost:53288';
        pendingTerminalConnect = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
        };

        await renderRootLayout();

        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/terminal/connect#key=abc123&server=http%3A%2F%2Fhappier-repo-dev-a1cc5e0671.localhost%3A53288');
    });

    it('redirects legacy `/?id=<sessionId>` deep-links to the canonical session route on web', async () => {
        const { historyReplaceStateSpy } = installWebLocation({
            href: 'https://app.example.test/?id=session-123',
        });

        const { consumeLegacySessionDeepLinkFromWebLocation } = await import('@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation');

        const didConsume = consumeLegacySessionDeepLinkFromWebLocation({
            isAuthenticated: true,
            replaceRelativeUrl: (nextRelativeUrl) => {
                window.history.replaceState(null, '', nextRelativeUrl);
            },
            navigateToRoute: (route) => {
                routerReplaceSpy(route);
            },
        });

        expect(didConsume).toBe(true);
        expect(historyReplaceStateSpy).toHaveBeenCalledWith(null, '', '/');
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-123');
    });
});
