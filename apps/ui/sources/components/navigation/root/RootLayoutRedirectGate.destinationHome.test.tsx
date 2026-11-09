// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';

installTokenStorageWebPlatformMocks();
const navigation = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string>, segments: [] as string[] }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => navigation.pathname,
        params: () => navigation.params,
        segments: () => navigation.segments,
    }).module;
});

await initializeAuthRouteRuntimeForTests();
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { resolveBootCredentials } = await import('@/boot/resolveBootCredentials');
const { runAppBootSequence } = await import('@/boot/runAppBootSequence');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const profiles = await import('@/sync/domains/server/serverProfiles');
const { RootLayoutRedirectGate, WebServerOverrideGate } = await import('./RootLayoutRedirectGate');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const networkReads = vi.fn(async () => new Response('{}', { status: 404 }));

describe('cold destination Home through boot and root redirect admission', () => {
    let storage: ReturnType<typeof installLocalStorageMock>;
    let locks: ReturnType<typeof installWebLockManagerMock>;

    beforeEach(() => {
        storage = installLocalStorageMock();
        locks = installWebLockManagerMock();
        networkReads.mockClear();
        setRuntimeFetch(networkReads);
    });
    afterEach(() => {
        locks.restore();
        storage.restore();
        vi.unstubAllGlobals();
    });

    async function coldLoad(pathname: string, serverId?: string) {
        navigation.pathname = pathname;
        navigation.params = serverId ? { serverId } : {};
        navigation.segments = ['(app)', ...pathname.split('/').filter(Boolean)];
        const href = `https://app.example.test${pathname}${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ''}#retained-target`;
        vi.stubGlobal('window', { localStorage: globalThis.localStorage, location: { href }, history: { replaceState: vi.fn() } });
        let credentials: Awaited<ReturnType<typeof resolveBootCredentials>> = null;
        await runAppBootSequence({
            loadFonts: async () => {}, sodiumReady: Promise.resolve(),
            resolveCredentials: () => resolveBootCredentials('web'),
            prepareWarmCache: async () => {}, prepareSessionDrafts: async () => {},
            prepareTranslations: async () => {}, restoreSync: null,
            onReady: (state) => { credentials = state.credentials; },
        });
        const protectedMount = vi.fn();
        function ProtectedSurface() { protectedMount(); return <div data-testid="protected-destination" />; }
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <WebServerOverrideGate><RootLayoutRedirectGate><ProtectedSurface /></RootLayoutRedirectGate></WebServerOverrideGate>
        </InjectedAuthProvider>);
        return { screen, credentials, protectedMount, href };
    }

    // FIX-F4-BRIEF.md: unknown Home gets an explicit refusal, preserving the destination.
    it.each([
        '/settings/machines/presets/preset-a',
        '/settings/machines/managed/resource-a',
        '/settings/machines/add/provisioner-a',
        '/session/session-a',
        '/projects/project-a',
        '/plugins/plugin-a/page-a',
    ])('preserves an unknown Home destination without borrowing retained authority: %s', async (pathname) => {
        const retained = await upsertAndActivateServer({ serverUrl: 'https://retained.example.test', source: 'manual', scope: 'device' });
        const retainedCredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' };
        expect(await TokenStorage.setCredentials(retainedCredentials)).toBe(true);
        const { screen, credentials, protectedMount, href } = await coldLoad(pathname, 'fix-f4-unknown-home');
        try {
            expect(credentials).toBeNull();
            expect(screen.findByTestId('root-destination-unknown-home')).not.toBeNull();
            expect(screen.findAllByType('Redirect' as never)).toHaveLength(0);
            expect(protectedMount).not.toHaveBeenCalled();
            expect(networkReads).not.toHaveBeenCalled();
            expect(window.location.href).toBe(href);
            expect(profiles.getActiveServerSnapshot().serverId).toBe(retained.id);
            expect(profiles.getServerProfileById('fix-f4-unknown-home')).toBeNull();
            await expect(TokenStorage.getCredentialsForServerUrl(retained.serverUrl, { serverId: retained.id })).resolves.toEqual(retainedCredentials);
        } finally { await screen.unmount(); }
    });

    it('still redirects a known signed-out Home without mounting its protected destination', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://signed-out.example.test', source: 'manual', scope: 'device' });
        const { screen, protectedMount } = await coldLoad('/settings/machines/presets/preset-a', home.id);
        try {
            expect(screen.findAllByType('Redirect' as never)).toHaveLength(1);
            expect(protectedMount).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it('admits the known destination using only that Home and preserves the route', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://known.example.test', source: 'manual', scope: 'device' });
        const saved = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' };
        expect(await TokenStorage.setCredentials(saved)).toBe(true);
        const { screen, credentials, href } = await coldLoad('/settings/machines/presets/preset-a', home.id);
        try {
            expect(credentials).toEqual(saved);
            expect(screen.findByTestId('protected-destination')).not.toBeNull();
            expect(screen.findAllByType('Redirect' as never)).toHaveLength(0);
            expect(window.location.href).toBe(href);
        } finally { await screen.unmount(); }
    });
});
