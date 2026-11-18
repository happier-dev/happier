// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createSignInServiceFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { initializeTerminalRouteRuntimeForTests } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';

installTokenStorageWebPlatformMocks();
vi.mock('expo-constants', async (importOriginal) => {
    const actual = await importOriginal<typeof import('expo-constants')>();
    return { ...actual, default: { ...actual.default, expoConfig: {
        ...actual.default.expoConfig,
        extra: { ...actual.default.expoConfig?.extra, app: { postHogKey: 'ph_home_entry_test' } },
    } } };
});
// PostHog is an external SDK; keep selection and feature discovery real.
vi.mock('posthog-react-native', () => ({
    default: class PostHogBoundary {
        optIn = vi.fn(async () => {});
        optOut = vi.fn(async () => {});
        identify = vi.fn();
        group = vi.fn();
        capture = vi.fn();
        reset = vi.fn();
        flush = vi.fn(async () => {});
    },
}));
const navigation = vi.hoisted(() => ({ pathname: '/', segments: ['index'], params: {} as Record<string, string>, replace: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => navigation.pathname,
        params: () => navigation.params,
        segments: () => navigation.segments,
        router: { replace: (href) => {
            navigation.replace(href);
            navigation.pathname = String(href).split('?')[0];
            navigation.params = {};
        } },
    }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: false }).module;
});
const runtimeFetch = vi.hoisted(() => vi.fn(async (_url: unknown, _options: unknown) => new Response('', { status: 503 })));
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch,
}));

// Warm the real graph during collection; individual cases still reset domain state.
await initializeTerminalRouteRuntimeForTests();
await import('./RootLayoutRedirectGate');

describe('supplied Home admission before shell mount', () => {
    let storage: ReturnType<typeof installLocalStorageMock>;
    let locks: ReturnType<typeof installWebLockManagerMock>;

    beforeEach(async () => {
        // The real connection owner stays live across cases; retain its generation lifetime.
        storage = installLocalStorageMock();
        locks = installWebLockManagerMock();
        const { resetServerProfilesRuntimeForTests } = await import('@/sync/domains/server/serverProfiles');
        resetServerProfilesRuntimeForTests({ preserveGenerations: true });
        runtimeFetch.mockReset();
        runtimeFetch.mockImplementation(async () => new Response('', { status: 503 }));
        navigation.pathname = '/';
        navigation.segments = ['index'];
        navigation.params = {};
        navigation.replace.mockReset();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        locks.restore();
        storage.restore();
        vi.unstubAllGlobals();
    });

    async function mountFor(address: string, onMount: (serverUrl: string) => void, withNavigation = false, historyState: unknown = null, fragment = '', source: 'location' | 'route' = 'location') {
        // Match the app entry: the real Sync runtime must be registered before
        // Router admission can switch a Home. resetModules retires that runtime.
        await import('@/sync/syncEngine');
        const location = { href: `https://app.example.test${navigation.pathname}?${source === 'location' ? `server=${encodeURIComponent(address)}&` : ''}tab=work${fragment}` };
        // Browser history is the external boundary. Apply writes so assertions
        // observe the retained URL/state rather than only an incidental call.
        const history = {
            state: historyState,
            replaceState: vi.fn((state: unknown, _title: string, relativeUrl: string) => {
                history.state = state;
                location.href = new URL(relativeUrl, location.href).href;
            }),
        };
        const replaceRelativeUrl = history.replaceState;
        vi.stubGlobal('window', {
            localStorage: globalThis.localStorage,
            location,
            history,
        });
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const profiles = await import('@/sync/domains/server/serverProfiles');
        await upsertAndActivateServer({ serverUrl: 'https://retained.example.test', source: 'manual', scope: 'device' });
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { RootLayoutRedirectGate, WebServerOverrideGate } = await import('./RootLayoutRedirectGate');
        function ShellProbe(): null {
            React.useEffect(() => onMount(profiles.getActiveServerSnapshot().serverUrl), []);
            return null;
        }
        const shell = withNavigation ? <RootLayoutRedirectGate><ShellProbe /></RootLayoutRedirectGate> : <ShellProbe />;
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><WebServerOverrideGate
            {...(source === 'route' ? { serverUrlOverride: address } : {})}>{shell}</WebServerOverrideGate></InjectedAuthProvider>);
        return { screen, replaceRelativeUrl, profiles, location, history };
    }

    it('verifies and selects the supplied Home before the unauthenticated shell mounts', async () => {
        const address = 'https://verified-first-load.example.test';
        let releaseHealth!: () => void;
        const healthPending = new Promise<void>((resolve) => { releaseHealth = resolve; });
        runtimeFetch.mockImplementation(async (rawUrl) => {
            const url = String(rawUrl);
            if (url.endsWith('/health')) await healthPending;
            return new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok' } : createSignInServiceFeaturesResponse(address)), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        });
        const mountedHomes: string[] = [];
        const { screen, profiles } = await mountFor(address, (serverUrl) => { mountedHomes.push(serverUrl); });
        try {
            expect(mountedHomes).toEqual([]);
            await vi.waitFor(() => expect(runtimeFetch).toHaveBeenCalledWith(`${address}/health`, expect.any(Object)));
            expect(profiles.listServerProfiles().some((profile) => profile.serverUrl === address)).toBe(false);
            await act(async () => { releaseHealth(); });
            const { Modal } = await import('@/modal');
            await vi.waitFor(() => expect(mountedHomes).toHaveLength(1));
            expect(Modal.confirm).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(mountedHomes).toEqual([address]));
        } finally {
            releaseHealth();
            await screen.unmount();
        }
    });

    it.each(['location', 'route'] as const)('selects the signed-in Artifact link Home from %s before mounting its signed-out landing and preserves the fragment for capture', async source => {
        const address = 'https://signed-link-destination.test';
        navigation.pathname = '/share/artifact/invite';
        navigation.segments = ['(app)', 'share', 'artifact', '[lookupId]'];
        runtimeFetch.mockImplementation(async rawUrl => Response.json(String(rawUrl).endsWith('/health')
            ? { status: 'ok' } : createSignInServiceFeaturesResponse(address)));
        const mountedHomes: string[] = [];
        const secret = 'c'.repeat(43);
        const { screen, location } = await mountFor(address, serverUrl => { mountedHomes.push(serverUrl); }, true, null, `#k=${secret}`, source);
        try {
            await vi.waitFor(() => expect(mountedHomes).toEqual([address]));
            expect(navigation.replace).not.toHaveBeenCalled();
            expect(new URL(location.href).hash).toBe(`#k=${secret}`);
            expect(new URL(location.href).searchParams.has('server')).toBe(false);
        } finally { await screen.unmount(); }
    });

    it('mounts the real sign-in surface with the admitted entry after query cleanup and zero requests to other Homes', async () => {
        const address = 'http://happier-entry.localhost:3033';
        const bakedDefault = 'https://owner-entry.example.test:8443';
        const previousDefault = process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = bakedDefault;
        const profiles = await import('@/sync/domains/server/serverProfiles');
        profiles.resetServerProfilesRuntimeForTests({ preserveGenerations: true });
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        const location = { href: `http://happier-entry.localhost:19364/?server=${encodeURIComponent(address)}` };
        vi.stubGlobal('window', { localStorage: globalThis.localStorage, location,
            history: { state: null, replaceState: (_state: unknown, _title: string, url: string) => {
                location.href = new URL(url, location.href).href;
            } } });
        runtimeFetch.mockImplementation(async (rawUrl) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/health') return Response.json({ status: 'ok' });
            if (url.pathname === '/v1/auth/entry') return new Response('', { status: 404 });
            return Response.json(createSignInServiceFeaturesResponse(address));
        });
        const { AuthProvider } = await import('@/auth/context/AuthContext');
        const { AppPaneModalProvider } = await import('@/components/appShell/providers/AppPaneModalProvider');
        const { WebServerOverrideGate } = await import('./RootLayoutRedirectGate');
        const { PreAuthOnboardingWizardEntry } = await import('@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<AuthProvider initialCredentials={null}><AppPaneModalProvider>
            <WebServerOverrideGate><PreAuthOnboardingWizardEntry /></WebServerOverrideGate>
        </AppPaneModalProvider></AuthProvider>);
        try {
            await vi.waitFor(async () => {
                await act(async () => {});
                const urls = runtimeFetch.mock.calls.map(([url]) => String(url));
                expect(urls, JSON.stringify({ urls, snapshot: profiles.getActiveServerSnapshot(), href: location.href })).toContain(`${address}/v1/auth/entry`);
            });
            expect(new URL(location.href).searchParams.has('server')).toBe(false);
            expect(profiles.readWebServerEntry()).toEqual({ serverUrl: address, isAdmitted: true });
            expect(screen.findHostByTestId('unauth-shell-route-welcome')).not.toBeNull();
            expect(runtimeFetch.mock.calls.filter(([url]) => new URL(String(url)).origin !== address)).toEqual([]);
        } finally {
            await screen.unmount();
            if (previousDefault === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
            else process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = previousDefault;
            profiles.resetServerProfilesRuntimeForTests({ preserveGenerations: true });
        }
    });

    it.each([true, false])('sends no requests to the baked or advertised Home with analytics mounted before explicit URL confirmation (useCanonical=%s)', async (useCanonical) => {
        const address = 'http://happier-qa.localhost:3033';
        const bakedDefault = 'https://baked-default.example.test';
        const previousDefault = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        const previousCurrentDefault = process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = bakedDefault;
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = bakedDefault;
        const profiles = await import('@/sync/domains/server/serverProfiles');
        profiles.resetServerProfilesRuntimeForTests({ preserveGenerations: true });
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        const location = { href: `http://happier-qa.localhost:19364/?server=${encodeURIComponent(address)}` };
        vi.stubGlobal('window', {
            localStorage: globalThis.localStorage,
            location,
            history: { state: null, replaceState: vi.fn() },
        });
        const { Modal } = await import('@/modal');
        let confirmAddress!: (accepted: boolean) => void;
        const confirmation = new Promise<boolean>((resolve) => { confirmAddress = resolve; });
        const confirm = vi.spyOn(Modal, 'confirm').mockReturnValue(confirmation);
        runtimeFetch.mockImplementation(async (rawUrl) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/health') return Response.json({ status: 'ok' });
            if (url.pathname === '/v1/auth/entry') return new Response('', { status: 404 });
            return Response.json(createSignInServiceFeaturesResponse(bakedDefault));
        });
        const { AuthProvider } = await import('@/auth/context/AuthContext');
        const { useAuthEntryOptions } = await import('@/components/account/auth/useAuthEntryOptions');
        const { WebServerOverrideGate } = await import('./RootLayoutRedirectGate');
        const { AppPaneModalProvider } = await import('@/components/appShell/providers/AppPaneModalProvider');
        const { SettingsAnalyticsRuntime } = await import('@/track/settingsAnalytics/SettingsAnalyticsRuntime');
        const { config } = await import('@/config');
        const { tracking } = await import('@/track/tracking');
        expect(config.postHogKey).toBe('ph_home_entry_test');
        expect(tracking).not.toBeNull();
        function SignIn(): null {
            useAuthEntryOptions();
            return null;
        }
        const screen = await renderScreen(<>
            {tracking ? <SettingsAnalyticsRuntime /> : null}
            <AuthProvider initialCredentials={null}><AppPaneModalProvider><WebServerOverrideGate><SignIn /></WebServerOverrideGate></AppPaneModalProvider></AuthProvider>
        </>);
        try {
            await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
            expect(runtimeFetch.mock.calls.map(([url]) => new URL(String(url)).origin)).not.toContain(bakedDefault);
            expect(runtimeFetch.mock.calls.some(([url]) => new URL(String(url)).origin === address)).toBe(true);
            await act(async () => { confirmAddress(useCanonical); });
            const admittedAddress = useCanonical ? bakedDefault : address;
            await vi.waitFor(async () => {
                await act(async () => {});
                const urls = runtimeFetch.mock.calls.map(([url]) => String(url));
                expect(urls, JSON.stringify({ urls, snapshot: profiles.getActiveServerSnapshot(), href: location.href })).toContain(`${admittedAddress}/v1/auth/entry`);
            });
            if (!useCanonical) expect(runtimeFetch.mock.calls.map(([url]) => new URL(String(url)).origin)).not.toContain(bakedDefault);
        } finally {
            confirmAddress(true);
            await screen.unmount();
            if (previousDefault === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
            else process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = previousDefault;
            if (previousCurrentDefault === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
            else process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = previousCurrentDefault;
            profiles.resetServerProfilesRuntimeForTests({ preserveGenerations: true });
        }
    });

    it('keeps the shell held after failure until the user dismisses the supplied intent', async () => {
        const { Modal } = await import('@/modal');
        let dismiss!: () => void;
        const choice = new Promise<boolean>((resolve) => { dismiss = () => resolve(false); });
        const confirm = vi.spyOn(Modal, 'confirm').mockReturnValue(choice);
        const mounted = vi.fn();
        const { screen, replaceRelativeUrl } = await mountFor('https://failed-first-load.example.test', mounted);
        try {
            expect(mounted).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
            expect(mounted).not.toHaveBeenCalled();
            expect(replaceRelativeUrl).not.toHaveBeenCalled();
            await act(async () => { dismiss(); });
            await vi.waitFor(() => expect(mounted).toHaveBeenCalled());
            expect(replaceRelativeUrl).toHaveBeenCalledWith(null, '', '/?tab=work');
        } finally {
            dismiss();
            await screen.unmount();
        }
    });

    it('keeps an explicitly dismissed Home draft ahead of session auth-recovery navigation', async () => {
        navigation.pathname = '/session/session-cancel/settings';
        navigation.params = { id: 'session-cancel' };
        const { Modal } = await import('@/modal');
        let dismiss!: () => void;
        const choice = new Promise<boolean>((resolve) => { dismiss = () => resolve(false); });
        const confirm = vi.spyOn(Modal, 'confirm').mockReturnValue(choice);
        const { screen, profiles } = await mountFor('https://failed-session-home.example.test', () => {}, true);
        try {
            await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
            const { storage } = await import('@/sync/domains/state/storage');
            await act(async () => {
                storage.getState().setSyncError({ kind: 'auth', message: 'Authentication required', retryable: false, at: 1, serverId: profiles.getActiveServerSnapshot().serverId });
                dismiss();
            });
            // The tracked router is the boundary: `vi.restoreAllMocks()` in earlier cases clears its
            // delegate to `navigation`, so the navigation request itself is observed.
            const { router } = await import('expo-router');
            const draft = '/settings/server/add?address=https%3A%2F%2Ffailed-session-home.example.test&source=url';
            await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(draft));
            // Auth recovery never navigated ahead of the dismissed Home draft.
            expect(router.replace).toHaveBeenNthCalledWith(1, draft);
        } finally {
            dismiss();
            await screen.unmount();
        }
    });

    it('preserves newer navigation and its history entry after a same-Home auth refresh succeeds', async () => {
        const address = 'https://retained.example.test';
        navigation.pathname = '/settings/actions/session.spawn_new';
        const retainedEntry = { key: 'expo-entry', workspace: { position: 4 } };
        // Same-Home refresh leaves the shell live. Queue genuine browser
        // navigation while the real injected auth provider completes its await.
        const { screen, location, history } = await mountFor(address, () => {
            queueMicrotask(() => {
                window.location.href = `https://app.example.test/settings/sub-agent?server=${encodeURIComponent(address)}&panel=delegation#report-back`;
            });
        }, false, retainedEntry);
        try {
            await vi.waitFor(() => expect(history.replaceState).toHaveBeenCalled(), { timeout: 300000 });
            const current = new URL(location.href);
            expect({ pathname: current.pathname, search: current.search, hash: current.hash, state: history.state }).toEqual({
                pathname: '/settings/sub-agent', search: '?panel=delegation', hash: '#report-back', state: retainedEntry,
            });
        } finally {
            await screen.unmount();
        }
    });

    it('preserves newer navigation and its history entry when the supplied Home is dismissed', async () => {
        const address = 'https://navigation-dismissed.example.test';
        navigation.pathname = '/settings/actions/session.spawn_new';
        let completeHealth!: () => void;
        const healthPending = new Promise<void>((resolve) => { completeHealth = resolve; });
        let dismiss!: () => void;
        const choice = new Promise<boolean>((resolve) => { dismiss = () => resolve(false); });
        const { Modal } = await import('@/modal');
        const confirm = vi.spyOn(Modal, 'confirm').mockReturnValue(choice);
        runtimeFetch.mockImplementation(async (rawUrl) => {
            const url = String(rawUrl);
            if (url.endsWith('/health')) await healthPending;
            return new Response('', { status: 503 });
        });
        const retainedEntry = { key: 'expo-entry', workspace: { position: 4 } };
        const { screen, location, history } = await mountFor(address, () => {}, false, retainedEntry);
        try {
            await vi.waitFor(() => expect(runtimeFetch).toHaveBeenCalledWith(`${address}/health`, expect.any(Object)));
            location.href = `https://app.example.test/settings/sub-agent?server=${encodeURIComponent(address)}&panel=delegation#report-back`;
            await act(async () => { completeHealth(); });
            await vi.waitFor(() => expect(confirm).toHaveBeenCalled(), { timeout: 300000 });
            await act(async () => { dismiss(); });
            await vi.waitFor(() => expect(history.replaceState).toHaveBeenCalled(), { timeout: 300000 });

            const current = new URL(location.href);
            expect({ pathname: current.pathname, search: current.search, hash: current.hash, state: history.state }).toEqual({
                pathname: '/settings/sub-agent', search: '?panel=delegation', hash: '#report-back', state: retainedEntry,
            });
        } finally {
            completeHealth();
            dismiss();
            await screen.unmount();
        }
    });
});
