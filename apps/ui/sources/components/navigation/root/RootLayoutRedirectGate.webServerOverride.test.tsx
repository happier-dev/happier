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
await initializeTerminalRouteRuntimeForTests();
await import('./RootLayoutRedirectGate');

describe('supplied Home admission before shell mount', () => {
    let storage: ReturnType<typeof installLocalStorageMock>;
    let locks: ReturnType<typeof installWebLockManagerMock>;

    beforeEach(() => {
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

    async function mountFor(address: string, onMount: (serverUrl: string) => void, withNavigation = false) {
        const replaceRelativeUrl = vi.fn();
        vi.stubGlobal('window', {
            localStorage: globalThis.localStorage,
            location: { href: `https://app.example.test${navigation.pathname}?server=${encodeURIComponent(address)}&tab=work` },
            history: { replaceState: replaceRelativeUrl },
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
        return { screen, replaceRelativeUrl, profiles };
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
});
