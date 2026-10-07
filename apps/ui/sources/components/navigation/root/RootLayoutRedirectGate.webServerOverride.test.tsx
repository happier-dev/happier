// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createSignInServiceFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

installTokenStorageWebPlatformMocks();
const navigation = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string>, replace: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => navigation.pathname,
        params: () => navigation.params,
        segments: ['index'],
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
await import('./RootLayoutRedirectGate');

describe('supplied Home admission before shell mount', () => {
    let storage: ReturnType<typeof installLocalStorageMock>;
    let locks: ReturnType<typeof installWebLockManagerMock>;

    beforeEach(() => {
        vi.resetModules();
        storage = installLocalStorageMock();
        locks = installWebLockManagerMock();
        runtimeFetch.mockReset();
        runtimeFetch.mockImplementation(async () => new Response('', { status: 503 }));
        navigation.pathname = '/';
        navigation.params = {};
        navigation.replace.mockReset();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        locks.restore();
        storage.restore();
        vi.unstubAllGlobals();
    });

    async function mountFor(address: string, onMount: (serverUrl: string) => void, withNavigation = false, historyState: unknown = null) {
        // Match the app entry: the real Sync runtime must be registered before
        // Router admission can switch a Home. resetModules retires that runtime.
        await import('@/sync/syncEngine');
        const location = { href: `https://app.example.test${navigation.pathname}?server=${encodeURIComponent(address)}&tab=work` };
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
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><WebServerOverrideGate>{shell}</WebServerOverrideGate></InjectedAuthProvider>);
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

    it('defers supplied Home admission while a journey owns the demo and keeps a same-Home teardown mounted', async () => {
        const address = 'https://journey-home.example.test';
        const demo = await import('@/demoMode/runtime/enterExitDemoMode');
        const journey = await import('@/components/onboarding/tour/state/journeySession');
        demo.enterDemoMode();
        journey.beginOnboardingJourneySession();
        const mountedHomes: string[] = [];
        const { screen, replaceRelativeUrl } = await mountFor(address, (serverUrl) => { mountedHomes.push(serverUrl); });
        try {
            expect(mountedHomes).toEqual(['https://retained.example.test']);
            expect(runtimeFetch).not.toHaveBeenCalled();
            const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
            await act(async () => {
                await upsertAndActivateServer({ serverUrl: address, source: 'manual', scope: 'device' });
                demo.exitDemoMode();
            });
            await vi.waitFor(() => expect(replaceRelativeUrl).toHaveBeenCalledWith(null, '', '/?tab=work'));
            expect(mountedHomes).toHaveLength(1);
        } finally {
            await act(async () => {
                demo.exitDemoMode();
                journey.endOnboardingJourneySession();
            });
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
            await vi.waitFor(() => expect(navigation.pathname).toBe('/settings/server/add'));
            expect(navigation.replace).toHaveBeenCalledWith('/settings/server/add?address=https%3A%2F%2Ffailed-session-home.example.test&source=url');
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
