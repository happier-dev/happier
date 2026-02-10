import { afterEach, describe, expect, it, vi } from 'vitest';

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stubWebRuntime(origin: string) {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => void store.clear(),
    });
    vi.stubGlobal('window', { location: { origin } });
    vi.stubGlobal('document', {});
}

async function importFreshServerConfig() {
    vi.resetModules();
    return await import('./serverConfig');
}

describe('getServerUrl', () => {
    const previousEnv = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    const previousContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    afterEach(() => {
        vi.unstubAllGlobals();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = previousEnv;
        if (previousContext === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = previousContext;
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('uses window.location.origin on web when EXPO_PUBLIC_HAPPY_SERVER_URL is empty', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://stack.example.test');
    });

    it('falls back to default when EXPO_PUBLIC_HAPPY_SERVER_URL is empty but origin is null', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('null');

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://api.happier.dev');
    });

    it('uses window.location.origin on web when EXPO_PUBLIC_HAPPY_SERVER_URL is unset', async () => {
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        stubWebRuntime('https://stack.example.test');

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://stack.example.test');
    });

    it('falls back to default on native when EXPO_PUBLIC_HAPPY_SERVER_URL is unset', async () => {
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://api.happier.dev');
    });

    it('trims EXPO_PUBLIC_HAPPY_SERVER_URL to avoid whitespace issues', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = ' https://stack.example.test ';

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://stack.example.test');
    });

    it('prefers a custom server URL over EXPO_PUBLIC_HAPPY_SERVER_URL', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');

        const { getServerUrl, setServerUrl } = await importFreshServerConfig();
        try {
            setServerUrl('https://custom.example.test');
            expect(getServerUrl()).toBe('https://custom.example.test');
        } finally {
            setServerUrl(null);
        }
    });

    it('respects sessionStorage activeServerId override on web', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');

        const profiles = await (async () => {
            vi.resetModules();
            return await import('./serverProfiles');
        })();

        const created = profiles.upsertServerProfile({ serverUrl: 'https://device.example.test', name: 'Device' });
        profiles.setActiveServerId(created.id, { scope: 'device' });
        profiles.setActiveServerId('cloud', { scope: 'tab' });

        const { getServerUrl } = await importFreshServerConfig();
        expect(getServerUrl()).toBe('https://api.happier.dev');
    });

    it('resetting a custom server returns to the stack default server (no cloud profile in stack context)', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013/';

        const { getServerUrl, isUsingCustomServer, setServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('http://localhost:3013');
        expect(isUsingCustomServer()).toBe(false);

        setServerUrl('https://custom.example.test/');
        expect(getServerUrl()).toBe('https://custom.example.test');
        expect(isUsingCustomServer()).toBe(true);

        // This must not attempt to select the cloud server id in stack context unless explicitly saved.
        setServerUrl(null);
        expect(getServerUrl()).toBe('http://localhost:3013');
        expect(isUsingCustomServer()).toBe(false);

        const profiles = await import('./serverProfiles');
        expect(profiles.listServerProfiles().some((p) => p.id === 'cloud')).toBe(false);
    });
});
