// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { scopedStorageId } from '@/utils/system/storageScope';

import * as switches from '../activeServerSwitch';
import * as profiles from '../serverProfiles';
import { setActiveServer } from '../serverRuntime';
import {
    bootstrapActiveServerFromWebLocation,
    commitWebServerUrlOverride,
    consumeWebServerUrlOverrideFromLocation,
    readWebDestinationServerIdFromLocation,
    readWebServerUrlOverrideFromLocation,
} from './bootstrapActiveServerFromWebLocation';
import { resolveWebServerUrlOverrideAction } from './resolveAuthenticatedWebServerUrlOverrideAction';

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stubWebLocation(href: string) {
    const location = { href };
    const history = {
        state: null as unknown,
        replaceState: vi.fn((state: unknown, _title: string, relativeUrl: string) => {
            history.state = state;
            location.href = new URL(relativeUrl, location.href).href;
        }),
    };
    vi.stubGlobal('window', {
        location,
        history,
    });
    const lockTails = new Map<string, Promise<void>>();
    vi.stubGlobal('navigator', {
        locks: {
            request: <T>(name: string, callback: () => T | PromiseLike<T>): Promise<T> => {
                const previous = lockTails.get(name) ?? Promise.resolve();
                const result = previous.then(callback);
                lockTails.set(name, result.then(() => undefined, () => undefined));
                return result;
            },
        },
    });
}

describe('bootstrapActiveServerFromWebLocation', () => {
    const previousEnv = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    const previousContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    const previousPreconfigured = process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let seededBrowserStorage: ReturnType<typeof installLocalStorageMock> | null = null;

    afterEach(() => {
        seededBrowserStorage?.restore();
        seededBrowserStorage = null;
        vi.unstubAllGlobals();
        profiles.resetServerProfilesRuntimeForTests();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = previousEnv;
        if (previousContext === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = previousContext;
        if (previousPreconfigured === undefined) delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        else process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = previousPreconfigured;
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('activates a saved Home from the web query string immediately', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:57012';

        stubWebLocation('http://happier-github-auth-e2ee.localhost:19081/?server=http%3A%2F%2Flocalhost%3A57010');

        await profiles.upsertServerProfile({ serverUrl: 'http://localhost:57010', source: 'manual' });

        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        expect(profiles.getActiveServerUrl()).toBe('http://localhost:57010');
        expect(result?.serverUrl).toBe('http://localhost:57010');
    });

    it('treats an explicit URL matching the seeded Home as a Home selection', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://canonical.example.test';
        stubWebLocation('https://app.example.test/?server=https%3A%2F%2Fcanonical.example.test');

        expect(profiles.getActiveServerSnapshot().isSelectionExplicit).toBe(false);

        await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        expect(profiles.getActiveServerUrl()).toBe('https://canonical.example.test');
        expect(profiles.getActiveServerSnapshot().isSelectionExplicit).toBe(true);
    });

    it.each([
        { target: 'id', scope: 'device' },
        { target: 'url', scope: 'device' },
        { target: 'id', scope: 'tab' },
        { target: 'url', scope: 'tab' },
    ] as const)('retains explicit intent when selecting the already focused implicit Home by $target in $scope scope', async ({ target, scope }) => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://canonical.example.test';
        stubWebLocation('https://app.example.test/');
        const active = profiles.getActiveServerSnapshot();
        expect(active.isSelectionExplicit).toBe(false);

        const result = target === 'id'
            ? await switches.setActiveServerAndSwitch({ serverId: active.serverId, scope })
            : await switches.upsertActivateAndSwitchServer({ serverUrl: active.serverUrl, scope });

        expect(result).toBe('already_active');
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: active.serverId,
            serverUrl: active.serverUrl,
            isSelectionExplicit: true,
        });
    });

    it('publishes the retained selection when a supplied Home is dismissed', () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://retained.example.test';
        const serverUrl = 'https://new.example.test';
        stubWebLocation(`https://app.example.test/?server=${encodeURIComponent(serverUrl)}`);
        const published: string[] = [];
        const unsubscribe = profiles.subscribeActiveServer((snapshot) => { published.push(snapshot.serverUrl); });
        try {
            consumeWebServerUrlOverrideFromLocation({ serverUrl });
            expect(published).toEqual(['https://retained.example.test']);
        } finally {
            unsubscribe();
        }
    });

    it('keeps an unknown Home URL pending until the connect flow admits it', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://retained.example.test';
        stubWebLocation('https://app.example.test/?server=https%3A%2F%2Fnew.example.test');

        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        expect(result?.serverUrl).toBe('https://new.example.test');
        expect(profiles.getActiveServerUrl()).toBe('');
        // A competing build default is not a saved Home.
        expect(profiles.getDeviceDefaultServerId()).toBe('');
        expect(profiles.listServerProfiles().some((profile) => profile.serverUrl === 'https://new.example.test')).toBe(false);
    });

    it('does not choose one of two saved Homes with the same supplied URL', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://retained.example.test';
        // Web profiles read browser storage, not native MMKV. Seed the genuine persistence boundary.
        seededBrowserStorage = installLocalStorageMock();
        seededBrowserStorage.store.set(`${scopedStorageId('server-profiles', scope)}:server-state-v1`, JSON.stringify({
            activeServerId: 'retained',
            activeServerIdIsExplicit: true,
            servers: {
                retained: { id: 'retained', name: 'Retained', serverUrl: 'https://retained.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
                first: { id: 'first', name: 'First', serverUrl: 'https://shared.example.test', canonicalServerUrl: 'https://shared.example.test', serverIdentityId: 'srv_first', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
                second: { id: 'second', name: 'Second', serverUrl: 'https://shared.example.test', canonicalServerUrl: 'https://shared.example.test', serverIdentityId: 'srv_second', createdAt: 2, updatedAt: 2, lastUsedAt: 2 },
            },
        }));
        stubWebLocation('https://app.example.test/?server=https%3A%2F%2Fshared.example.test');

        expect(profiles.resolveSavedServerProfileByUrl('https://shared.example.test')).toMatchObject({ kind: 'ambiguous' });
        expect(profiles.resolveUniqueServerProfileByUrl('https://shared.example.test')).toBeNull();
        await bootstrapActiveServerFromWebLocation({ scope: 'device' });
        expect(profiles.getActiveServerId()).toBe('');
        expect(profiles.getDeviceDefaultServerId()).toBe('retained');

        // URL equality cannot select a stable identity when two saved Homes share it.
        await setActiveServer({ serverId: 'first', scope: 'device' });
        expect(profiles.getActiveServerId()).toBe('srv_first');
        expect(profiles.getActiveServerUrl()).toBe('https://shared.example.test');
        expect(resolveWebServerUrlOverrideAction({})).toMatchObject({
            kind: 'switch_server',
            serverUrl: 'https://shared.example.test',
        });
    });

    it('refreshes auth for a uniquely saved loopback-equivalent Home without switching it', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:53288';
        stubWebLocation('https://app.example.test/?server=http%3A%2F%2Fhappier-qa.localhost%3A53288');
        await profiles.upsertServerProfile({ serverUrl: 'http://localhost:53288', source: 'manual' });
        expect(resolveWebServerUrlOverrideAction({ bootstrappedServerUrl: 'http://localhost:53288' })).toEqual({
            kind: 'refresh_auth', serverUrl: 'http://happier-qa.localhost:53288',
        });
    });

    it('normalizes legacy `?url=...&auto=1` into the same device-scoped server override flow', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebLocation('https://app.example.test/server?url=https%3A%2F%2Fstack.example.test&auto=1');
        expect(resolveWebServerUrlOverrideAction({ bootstrappedServerUrl: null })).toEqual({
            kind: 'switch_server',
            serverUrl: 'https://stack.example.test',
        });
    });

    it('reuses the same equivalent loopback server profile without rewriting its stored url', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://qa-stack.localhost:57010';

        stubWebLocation('http://happier-github-auth-e2ee.localhost:19081/?server=http%3A%2F%2F127.0.0.1%3A57010');

        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        expect(profiles.getActiveServerId()).toBe('qa-stack.localhost-57010');
        expect(profiles.getActiveServerUrl()).toBe('http://qa-stack.localhost:57010');
        expect(result?.serverUrl).toBe('http://127.0.0.1:57010');
    });

    it('adopts an explicit stack hostname override when the active profile uses generic localhost', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:57010';

        stubWebLocation('http://happier-repo-dev-a1cc5e0671.localhost:19081/?server=http%3A%2F%2Fhappier-repo-dev-a1cc5e0671.localhost%3A57010');

        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        expect(profiles.getActiveServerId()).toBe('localhost-57010');
        expect(profiles.getActiveServerUrl()).toBe('http://happier-repo-dev-a1cc5e0671.localhost:57010');
        expect(result?.serverUrl).toBe('http://happier-repo-dev-a1cc5e0671.localhost:57010');
    });

    it.each(['127.0.0.1-57010', 'srv_other_home'])('preserves destination Home scope %s when consuming a web server override', async serverId => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:57010';

        stubWebLocation(`http://happier-github-auth-e2ee.localhost:19081/session/session-1?server=http%3A%2F%2F127.0.0.1%3A57010&serverId=${serverId}&tab=files`);

        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        expect(result?.serverUrl).toBe('http://127.0.0.1:57010');
        expect(result?.cleanedRelativeUrl).toBe(`/session/session-1?serverId=${serverId}&tab=files`);
    });

    it.each([
        'https://app.example.test/terminal?key=abc123&server=https%3A%2F%2Fwrong.example.test&serverId=terminal-owned-home',
        'https://app.example.test/terminal/connect?key=abc123&server=https%3A%2F%2Fwrong.example.test&serverId=terminal-owned-home',
    ])('does not consume terminal route server params as global overrides for %s', async (href) => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://api.happier.dev';

        stubWebLocation(href);

        const override = readWebServerUrlOverrideFromLocation();
        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        expect(override).toBeNull();
        expect(readWebDestinationServerIdFromLocation()).toBeNull();
        expect(result).toBeNull();
      expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('removes the URL intent only after the server connection and auth commit succeeds', async () => {
        const events: string[] = [];
        stubWebLocation('https://app.example.test/session/session-1?server=https%3A%2F%2Fstack.example.test');
        vi.mocked(window.history.replaceState).mockImplementation((_state, _title, url) => {
            events.push(`replace:${String(url)}`);
        });
        await commitWebServerUrlOverride({
            action: {
                kind: 'switch_server',
                serverUrl: 'https://stack.example.test',
            },
            switchServer: async () => {
                events.push('connected-and-authenticated');
            },
            refreshAuth: async () => {
                events.push('refresh-auth');
            },
        });
        expect(events).toEqual([
            'connected-and-authenticated',
            'replace:/session/session-1',
        ]);
    });

    it('retains the URL intent when connection or auth commit rejects', async () => {
        stubWebLocation('https://app.example.test/?server=https%3A%2F%2Fstack.example.test');
        const replaceRelativeUrl = window.history.replaceState;
        await expect(commitWebServerUrlOverride({
            action: {
                kind: 'switch_server',
                serverUrl: 'https://stack.example.test',
            },
            switchServer: async () => {
                throw new Error('auth failed');
            },
            refreshAuth: async () => {},
        })).rejects.toThrow('auth failed');
        expect(replaceRelativeUrl).not.toHaveBeenCalled();
    });

    it('cleans the current route instead of restoring the route captured before auth refresh', async () => {
        const serverUrl = 'https://stack.example.test';
        stubWebLocation(`https://app.example.test/settings/actions/session.spawn_new?server=${encodeURIComponent(serverUrl)}&tab=old#old`);
        const supplied = readWebServerUrlOverrideFromLocation();
        if (!supplied) throw new Error('Expected the genuine URL decoder to admit the supplied Home');

        // Browser location/history and completion of external auth are the boundaries;
        // the override decoder and commit owner remain real.
        let completeAuth!: () => void;
        const authPending = new Promise<void>((resolve) => { completeAuth = resolve; });
        const commit = commitWebServerUrlOverride({
            action: { kind: 'refresh_auth', serverUrl: supplied.serverUrl },
            switchServer: async () => { throw new Error('Same-Home refresh must not switch Homes'); },
            refreshAuth: () => authPending,
        });
        expect(window.history.replaceState).not.toHaveBeenCalled();

        window.location.href = `https://app.example.test/settings/sub-agent?server=${encodeURIComponent(serverUrl)}&panel=delegation#report-back`;
        completeAuth();
        await commit;

        expect(new URL(window.location.href)).toMatchObject({
            pathname: '/settings/sub-agent',
            search: '?panel=delegation',
            hash: '#report-back',
        });
    });

    it.each([
        {
            reason: 'a different supplied Home',
            href: 'https://app.example.test/settings/sub-agent?server=https%3A%2F%2Fother.example.test&panel=delegation#report-back',
        },
        {
            reason: 'navigation that already removed the supplied intent',
            href: 'https://app.example.test/settings/sub-agent?panel=delegation#report-back',
        },
        {
            reason: 'terminal-owned server parameters',
            href: 'https://app.example.test/terminal/connect?server=https%3A%2F%2Fstack.example.test#key=terminal-fixture',
        },
    ])('does not consume $reason when auth completion arrives later', async ({ href }) => {
        const serverUrl = 'https://stack.example.test';
        stubWebLocation(`https://app.example.test/settings/actions/session.spawn_new?server=${encodeURIComponent(serverUrl)}`);
        const supplied = readWebServerUrlOverrideFromLocation();
        if (!supplied) throw new Error('Expected the genuine URL decoder to admit the supplied Home');
        let completeAuth!: () => void;
        const authPending = new Promise<void>((resolve) => { completeAuth = resolve; });
        const commit = commitWebServerUrlOverride({
            action: { kind: 'refresh_auth', serverUrl: supplied.serverUrl },
            switchServer: async () => { throw new Error('Same-Home refresh must not switch Homes'); },
            refreshAuth: () => authPending,
        });

        window.location.href = href;
        completeAuth();
        await commit;

        expect(window.location.href).toBe(href);
    });

    it('does not clean a supplied intent after its mounted owner cancels the pending commit', async () => {
        stubWebLocation('https://app.example.test/settings/sub-agent?server=https%3A%2F%2Fstack.example.test&panel=delegation#report-back');
        const supplied = readWebServerUrlOverrideFromLocation();
        if (!supplied) throw new Error('Expected the genuine URL decoder to admit the supplied Home');
        const controller = new AbortController();
        let completeAuth!: () => void;
        const authPending = new Promise<void>((resolve) => { completeAuth = resolve; });
        const retainedHref = window.location.href;
        // Forward the mounted Gate's existing lifecycle signal, not a new auth
        // cancellation mechanism. Completion can arrive despite owner retirement.
        const params = {
            action: { kind: 'refresh_auth' as const, serverUrl: supplied.serverUrl },
            signal: controller.signal,
            switchServer: async () => { throw new Error('Same-Home refresh must not switch Homes'); },
            refreshAuth: () => authPending,
        };
        const commit = commitWebServerUrlOverride(params);
        controller.abort();
        completeAuth();
        await commit;

        expect(window.location.href).toBe(retainedHref);
    });
});
