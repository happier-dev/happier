// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { scopedStorageId } from '@/utils/system/storageScope';

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stubWebLocation(href: string) {
    vi.stubGlobal('window', {
        location: { href },
        history: { replaceState: vi.fn() },
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

async function importFreshBootstrap() {
    vi.resetModules();
    return await import('./bootstrapActiveServerFromWebLocation');
}

async function importFreshServerProfiles() {
    return await import('../serverProfiles');
}

// Collect the real override graph before case deadlines; each case still reloads its scope.
await import('./resolveAuthenticatedWebServerUrlOverrideAction');

describe('bootstrapActiveServerFromWebLocation', () => {
    const previousEnv = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    const previousContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    const previousPreconfigured = process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let seededBrowserStorage: ReturnType<typeof installLocalStorageMock> | null = null;

    beforeEach(() => { vi.resetModules(); });

    afterEach(() => {
        seededBrowserStorage?.restore();
        seededBrowserStorage = null;
        vi.unstubAllGlobals();
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

        const { upsertServerProfile } = await importFreshServerProfiles();
        await upsertServerProfile({ serverUrl: 'http://localhost:57010', source: 'manual' });

        const { bootstrapActiveServerFromWebLocation } = await importFreshBootstrap();
        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        const { getActiveServerUrl } = await importFreshServerProfiles();
        expect(getActiveServerUrl()).toBe('http://localhost:57010');
        expect(result?.serverUrl).toBe('http://localhost:57010');
    });

    it('keeps an unknown Home URL pending until the connect flow admits it', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://retained.example.test';
        stubWebLocation('https://app.example.test/?server=https%3A%2F%2Fnew.example.test');

        const { bootstrapActiveServerFromWebLocation } = await importFreshBootstrap();
        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });
        const { getActiveServerUrl, listServerProfiles } = await importFreshServerProfiles();

        expect(result?.serverUrl).toBe('https://new.example.test');
        expect(getActiveServerUrl()).toBe('https://retained.example.test');
        expect(listServerProfiles().some((profile) => profile.serverUrl === 'https://new.example.test')).toBe(false);
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

        const { bootstrapActiveServerFromWebLocation } = await importFreshBootstrap();
        const { getActiveServerId, resolveSavedServerProfileByUrl, resolveUniqueServerProfileByUrl } = await importFreshServerProfiles();
        expect(resolveSavedServerProfileByUrl('https://shared.example.test')).toMatchObject({ kind: 'ambiguous' });
        expect(resolveUniqueServerProfileByUrl('https://shared.example.test')).toBeNull();
        await bootstrapActiveServerFromWebLocation({ scope: 'device' });
        expect(getActiveServerId()).toBe('retained');

        // URL equality cannot select a stable identity when two saved Homes share it.
        const { setActiveServer } = await import('../serverRuntime');
        await setActiveServer({ serverId: 'first', scope: 'device' });
        const { getActiveServerUrl } = await importFreshServerProfiles();
        expect(getActiveServerId()).toBe('srv_first');
        expect(getActiveServerUrl()).toBe('https://shared.example.test');
        const { resolveWebServerUrlOverrideAction } = await import('./resolveAuthenticatedWebServerUrlOverrideAction');
        expect(resolveWebServerUrlOverrideAction({})).toMatchObject({
            kind: 'switch_server',
            serverUrl: 'https://shared.example.test',
        });
    });

    it('refreshes auth for a uniquely saved loopback-equivalent Home without switching it', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:53288';
        stubWebLocation('https://app.example.test/?server=http%3A%2F%2Fhappier-qa.localhost%3A53288');
        await importFreshBootstrap();
        const { upsertServerProfile } = await importFreshServerProfiles();
        await upsertServerProfile({ serverUrl: 'http://localhost:53288', source: 'manual' });
        const { resolveWebServerUrlOverrideAction } = await import('./resolveAuthenticatedWebServerUrlOverrideAction');
        expect(resolveWebServerUrlOverrideAction({ bootstrappedServerUrl: 'http://localhost:53288' })).toEqual({
            kind: 'refresh_auth', cleanedRelativeUrl: '/',
        });
    });

    it('reuses the same equivalent loopback server profile without rewriting its stored url', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://qa-stack.localhost:57010';

        stubWebLocation('http://happier-github-auth-e2ee.localhost:19081/?server=http%3A%2F%2F127.0.0.1%3A57010');

        const { bootstrapActiveServerFromWebLocation } = await importFreshBootstrap();
        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        const { getActiveServerId, getActiveServerUrl } = await importFreshServerProfiles();
        expect(getActiveServerId()).toBe('qa-stack.localhost-57010');
        expect(getActiveServerUrl()).toBe('http://qa-stack.localhost:57010');
        expect(result?.serverUrl).toBe('http://127.0.0.1:57010');
    });

    it('adopts an explicit stack hostname override when the active profile uses generic localhost', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:57010';

        stubWebLocation('http://happier-repo-dev-a1cc5e0671.localhost:19081/?server=http%3A%2F%2Fhappier-repo-dev-a1cc5e0671.localhost%3A57010');

        const { bootstrapActiveServerFromWebLocation } = await importFreshBootstrap();
        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        const { getActiveServerId, getActiveServerUrl } = await importFreshServerProfiles();
        expect(getActiveServerId()).toBe('localhost-57010');
        expect(getActiveServerUrl()).toBe('http://happier-repo-dev-a1cc5e0671.localhost:57010');
        expect(result?.serverUrl).toBe('http://happier-repo-dev-a1cc5e0671.localhost:57010');
    });

    it('drops stale route serverId params when consuming a web server override', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:57010';

        stubWebLocation('http://happier-github-auth-e2ee.localhost:19081/session/session-1?server=http%3A%2F%2F127.0.0.1%3A57010&serverId=127.0.0.1-57010&tab=files');

        const { bootstrapActiveServerFromWebLocation } = await importFreshBootstrap();
        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        expect(result?.serverUrl).toBe('http://127.0.0.1:57010');
        expect(result?.cleanedRelativeUrl).toBe('/session/session-1?tab=files');
    });

    it.each([
        'https://app.example.test/terminal?key=abc123&server=https%3A%2F%2Fwrong.example.test',
        'https://app.example.test/terminal/connect?key=abc123&server=https%3A%2F%2Fwrong.example.test',
    ])('does not consume terminal route server params as global overrides for %s', async (href) => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://api.happier.dev';

        stubWebLocation(href);

        const { bootstrapActiveServerFromWebLocation, readWebServerUrlOverrideFromLocation } = await importFreshBootstrap();
        const override = readWebServerUrlOverrideFromLocation();
        const result = await bootstrapActiveServerFromWebLocation({ scope: 'device' });

        const { getActiveServerUrl } = await importFreshServerProfiles();
        expect(override).toBeNull();
        expect(result).toBeNull();
      expect(getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('removes the URL intent only after the server connection and auth commit succeeds', async () => {
        const events: string[] = [];
        const { commitWebServerUrlOverride } = await importFreshBootstrap();
        await commitWebServerUrlOverride({
            action: {
                kind: 'switch_server',
                serverUrl: 'https://stack.example.test',
                cleanedRelativeUrl: '/session/session-1',
            },
            switchServer: async () => {
                events.push('connected-and-authenticated');
            },
            refreshAuth: async () => {
                events.push('refresh-auth');
            },
            replaceRelativeUrl: (url) => {
                events.push(`replace:${url}`);
            },
        });
        expect(events).toEqual([
            'connected-and-authenticated',
            'replace:/session/session-1',
        ]);
    });

    it('retains the URL intent when connection or auth commit rejects', async () => {
        const replaceRelativeUrl = vi.fn();
        const { commitWebServerUrlOverride } = await importFreshBootstrap();
        await expect(commitWebServerUrlOverride({
            action: {
                kind: 'switch_server',
                serverUrl: 'https://stack.example.test',
                cleanedRelativeUrl: '/',
            },
            switchServer: async () => {
                throw new Error('auth failed');
            },
            refreshAuth: async () => {},
            replaceRelativeUrl,
        })).rejects.toThrow('auth failed');
        expect(replaceRelativeUrl).not.toHaveBeenCalled();
    });
});
