import { afterEach, describe, expect, it, vi } from 'vitest';

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stubWebLocation(href: string) {
    vi.stubGlobal('window', {
        location: { href },
        history: { replaceState: vi.fn() },
    });
    vi.stubGlobal('document', {});
}

function stubSessionStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
        clear: () => void store.clear(),
    });
}

async function importFreshBootstrap() {
    vi.resetModules();
    return await import('./bootstrapActiveServerFromWebLocation');
}

async function importFreshServerProfiles() {
    return await import('../serverProfiles');
}

describe('bootstrapActiveServerFromWebLocation', () => {
    const previousEnv = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    const previousContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    const previousPreconfigured = process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    afterEach(() => {
        vi.unstubAllGlobals();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = previousEnv;
        if (previousContext === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = previousContext;
        if (previousPreconfigured === undefined) delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        else process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = previousPreconfigured;
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('activates the server from the web query string immediately', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:57012';

        stubWebLocation('http://happier-github-auth-e2ee.localhost:19081/?server=http%3A%2F%2Flocalhost%3A57010');

        const { bootstrapActiveServerFromWebLocation } = await importFreshBootstrap();
        const result = bootstrapActiveServerFromWebLocation({ scope: 'device' });

        const { getActiveServerUrl } = await importFreshServerProfiles();
        expect(getActiveServerUrl()).toBe('http://localhost:57010');
        expect(result?.serverUrl).toBe('http://localhost:57010');
    });

    it('reuses the same equivalent loopback server profile without rewriting its stored url', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://qa-stack.localhost:57010';

        stubWebLocation('http://happier-github-auth-e2ee.localhost:19081/?server=http%3A%2F%2F127.0.0.1%3A57010');

        const { bootstrapActiveServerFromWebLocation } = await importFreshBootstrap();
        const result = bootstrapActiveServerFromWebLocation({ scope: 'device' });

        const { getActiveServerId, getActiveServerUrl } = await importFreshServerProfiles();
        expect(getActiveServerId()).toBe('qa-stack.localhost-57010');
        expect(getActiveServerUrl()).toBe('http://qa-stack.localhost:57010');
        expect(result?.serverUrl).toBe('http://127.0.0.1:57010');
    });

    it('drops stale route serverId params when consuming a web server override', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:57010';

        stubWebLocation('http://happier-github-auth-e2ee.localhost:19081/session/session-1?server=http%3A%2F%2F127.0.0.1%3A57010&serverId=127.0.0.1-57010&tab=files');

        const { bootstrapActiveServerFromWebLocation } = await importFreshBootstrap();
        const result = bootstrapActiveServerFromWebLocation({ scope: 'device' });

        expect(result?.serverUrl).toBe('http://127.0.0.1:57010');
        expect(result?.cleanedRelativeUrl).toBe('/session/session-1?tab=files');
        expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/session/session-1?tab=files');
    });

    it('promotes an equivalent tab override to the device active server from the web query string', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://device.example.test';
        stubSessionStorage();
        stubWebLocation('https://app.example.test/?server=https%3A%2F%2Ftab.example.test');

        vi.resetModules();
        const profiles = await importFreshServerProfiles();
        const deviceProfile = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        const tabProfile = profiles.upsertServerProfile({
            serverUrl: 'https://tab.example.test',
            name: 'Tab',
        });
        profiles.setActiveServerId(deviceProfile.id, { scope: 'device' });
        profiles.setActiveServerId(tabProfile.id, { scope: 'tab' });

        const { bootstrapActiveServerFromWebLocation } = await import('./bootstrapActiveServerFromWebLocation');
        const result = bootstrapActiveServerFromWebLocation({ scope: 'device' });

        expect(result?.serverUrl).toBe('https://tab.example.test');
        expect(profiles.getTabActiveServerId()).toBeNull();
        expect(profiles.getDeviceDefaultServerId()).toBe(tabProfile.id);
        expect(profiles.getActiveServerUrl()).toBe('https://tab.example.test');
    });

    it('does not consume terminal connect query params as a global server override', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://api.happier.dev';

        stubWebLocation('https://app.example.test/terminal/connect?key=abc123&server=https%3A%2F%2Fwrong.example.test');

        const { bootstrapActiveServerFromWebLocation, readWebServerUrlOverrideFromLocation } = await importFreshBootstrap();
        const override = readWebServerUrlOverrideFromLocation();
        const result = bootstrapActiveServerFromWebLocation({ scope: 'device' });

        const { getActiveServerUrl } = await importFreshServerProfiles();
        expect(override).toBeNull();
        expect(result).toBeNull();
        expect(getActiveServerUrl()).toBe('https://api.happier.dev');
    });
});
