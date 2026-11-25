// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { WizardAuthReturnRouteContext } from '@/components/onboarding/state/wizardResume';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';

installTokenStorageWebPlatformMocks();
const navigation = vi.hoisted(() => ({
    pathname: '/', params: {} as Record<string, string>, segments: [] as string[],
    replace: vi.fn(),
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => navigation.pathname,
        params: () => navigation.params,
        segments: () => navigation.segments,
        router: { replace: navigation.replace },
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
        navigation.replace.mockClear();
        setRuntimeFetch(networkReads);
    });
    afterEach(() => {
        locks.restore();
        storage.restore();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    function navigate(pathname: string, params: Record<string, string>) {
        navigation.pathname = pathname;
        navigation.params = params;
        navigation.segments = ['(app)', ...pathname.split('/').filter(Boolean)];
        const query = new URLSearchParams(params);
        const href = `https://app.example.test${pathname}${query.size ? `?${query}` : ''}#retained-target`;
        vi.stubGlobal('window', { localStorage: globalThis.localStorage, location: { href }, history: { replaceState: vi.fn() } });
        return href;
    }

    async function coldLoad(pathname: string, serverId?: string, params: Record<string, string> = {}) {
        const href = navigate(pathname, { ...params, ...(serverId ? { serverId } : {}) });
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
        function Welcome() {
            const entry = React.useContext(WizardAuthReturnRouteContext);
            return <button data-testid="welcome" onClick={() => entry?.abandon?.()}>Welcome</button>;
        }
        function App({ credentials }: Readonly<{ credentials: Awaited<ReturnType<typeof resolveBootCredentials>> }>) {
            return <InjectedAuthProvider credentials={credentials}>
                <WebServerOverrideGate><RootLayoutRedirectGate>
                    {navigation.pathname === '/' ? <Welcome /> : <ProtectedSurface />}
                </RootLayoutRedirectGate></WebServerOverrideGate>
            </InjectedAuthProvider>;
        }
        const screen = await renderScreen(<App credentials={credentials} />);
        async function finishSignIn(options?: { abandon?: boolean; switchHome?: boolean; publishHomeIdentity?: string }) {
            const redirect = screen.findByType('Redirect').props.href;
            expect(typeof redirect).toBe('string');
            const entry = new URL(redirect, 'https://app.example.test');
            navigate(entry.pathname, Object.fromEntries(entry.searchParams));
            await screen.update(<App credentials={null} />);
            expect(screen.findByTestId('welcome')).not.toBeNull();
            expect(protectedMount).not.toHaveBeenCalled();
            if (options?.abandon) {
                screen.findByTestId('welcome')?.props.onClick();
                expect(navigation.replace).toHaveBeenCalledExactlyOnceWith('/');
                navigate('/', {});
                await screen.update(<App credentials={null} />);
                navigation.replace.mockClear();
            }
            if (options?.switchHome) {
                await upsertAndActivateServer({ serverUrl: 'https://other-selected.example.test', source: 'manual', scope: 'device' });
            }
            if (options?.publishHomeIdentity) {
                const { serverUrl } = profiles.getActiveServerSnapshot();
                await profiles.adoptHomeProfile({
                    descriptor: { homeServerIdentityId: options.publishHomeIdentity, canonicalServerUrl: serverUrl, serverUrl },
                    source: 'manual',
                    descriptorAuthority: 'current_connection_observation',
                });
                expect(profiles.getActiveServerSnapshot().serverId).toBe(options.publishHomeIdentity);
            }
            await screen.update(<App credentials={{ token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' }} />);
            return redirect;
        }
        return { screen, credentials, protectedMount, href, finishSignIn };
    }

    it.each([
        { pathname: '/session/session-a/sharing', qualified: false },
        { pathname: '/session/session-a/sharing', qualified: true },
        { pathname: '/session/session-a', qualified: false },
        { pathname: '/settings/machines/presets/preset-a', qualified: false },
    ])('resumes $pathname after cold sign-in (Home-qualified: $qualified)', async ({ pathname, qualified }) => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://resume.example.test', source: 'manual', scope: 'device' });
        const { screen, protectedMount, finishSignIn } = await coldLoad(pathname, qualified ? home.id : undefined, { unrelated: 'discard-me' });
        try {
            const entry = await finishSignIn();
            const destination = pathname.startsWith('/session/') ? `${pathname}?serverId=${encodeURIComponent(home.id)}` : pathname;
            expect(entry).not.toContain('discard-me');
            expect(protectedMount).not.toHaveBeenCalled();
            expect(navigation.replace).toHaveBeenCalledExactlyOnceWith(destination);
        } finally { await screen.unmount(); }
    });

    it('keeps a bare cold destination while the device chooses its first Home', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', '{}');
        vi.stubEnv('EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS', '');
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_URL', '');
        vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', '');
        vi.stubEnv('EXPO_PUBLIC_SERVER_URL', '');
        profiles.resetServerProfilesRuntimeForTests({ preserveGenerations: true });
        const { screen, protectedMount, finishSignIn } = await coldLoad('/session/session-a/sharing');
        try {
            expect(profiles.getActiveServerSnapshot().serverId).toBe('');
            const entry = await finishSignIn({ switchHome: true });
            const chosenId = profiles.getActiveServerSnapshot().serverId;
            expect(entry).toContain('onboardingDestination');
            expect(protectedMount).not.toHaveBeenCalled();
            expect(navigation.replace).toHaveBeenCalledExactlyOnceWith(`/session/session-a/sharing?serverId=${encodeURIComponent(chosenId)}`);
        } finally { await screen.unmount(); }
    });

    it('resumes the destination when the same Home publishes its stable identity during sign-in', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://first-identity.example.test', source: 'manual', scope: 'device' });
        const { screen, protectedMount, finishSignIn } = await coldLoad('/session/session-a/sharing');
        try {
            const entry = await finishSignIn({ publishHomeIdentity: 'srv_resume_adopted' });
            expect(entry).toContain(home.id);
            expect(protectedMount).not.toHaveBeenCalled();
            expect(navigation.replace).toHaveBeenCalledExactlyOnceWith('/session/session-a/sharing?serverId=srv_resume_adopted');
        } finally { await screen.unmount(); }
    });

    it.each([
        { label: 'another Home', params: {}, options: { switchHome: true } },
        { label: 'another Account', params: { accountId: 'account-b' }, options: {} },
        { label: 'an abandoned sign-in', params: {}, options: { abandon: true } },
    ])('settles at Home after $label', async ({ params, options }) => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://scoped-resume.example.test', source: 'manual', scope: 'device' });
        const { screen, protectedMount, finishSignIn } = await coldLoad('/session/session-a/sharing', home.id, params);
        try {
            await finishSignIn(options);
            expect(protectedMount).not.toHaveBeenCalled();
            if ('abandon' in options) expect(navigation.replace).not.toHaveBeenCalled();
            else expect(navigation.replace).toHaveBeenCalledExactlyOnceWith('/');
        } finally { await screen.unmount(); }
    });

    it.each([
        'https://another.example.test/session/session-a/sharing', 'javascript:alert(1)', 'data:text/plain,hi',
        '//another.example.test', '%2F%2Fanother.example.test', '/%2Fanother.example.test',
        '/%252Fanother.example.test', '/\\another.example.test', '/%5Canother.example.test',
        '/session/%2e%2e/%2e%2e/home',
    ])('silently falls back for a hostile protected address: %s', async (pathname) => {
        const { screen, finishSignIn } = await coldLoad(pathname);
        try {
            expect(await finishSignIn()).toBe('/');
            expect(navigation.replace).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

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
