import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    const hostname = (() => {
        try {
            return new URL(origin).hostname;
        } catch {
            return '';
        }
    })();
    vi.stubGlobal('window', { location: { origin, hostname } });
    vi.stubGlobal('document', {});
}

async function importFreshServerConfig() {
    vi.resetModules();
    return await import('./serverConfig');
}

function restoreEnvVar(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
        return;
    }
    process.env[key] = value;
}

function clearServerEnv(): void {
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
    delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    delete process.env.EXPO_PUBLIC_SERVER_URL;
    delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
    delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
}

describe('getServerUrl', () => {
    const previousCanonicalEnv = process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
    const previousEnv = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    const previousLegacyGenericEnv = process.env.EXPO_PUBLIC_SERVER_URL;
    const previousContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    const previousPreconfigured = process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    beforeEach(() => {
        clearServerEnv();
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        restoreEnvVar('EXPO_PUBLIC_HAPPIER_SERVER_URL', previousCanonicalEnv);
        restoreEnvVar('EXPO_PUBLIC_HAPPY_SERVER_URL', previousEnv);
        restoreEnvVar('EXPO_PUBLIC_SERVER_URL', previousLegacyGenericEnv);
        restoreEnvVar('EXPO_PUBLIC_HAPPY_SERVER_CONTEXT', previousContext);
        restoreEnvVar('EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS', previousPreconfigured);
        restoreEnvVar('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', previousScope);
    });

    it('uses window.location.origin on web when EXPO_PUBLIC_HAPPY_SERVER_URL is empty', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://stack.example.test');
    });

    it('prefers injected web runtime config serverUrl over window.location.origin when env is empty', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');
        vi.stubGlobal('window', {
            location: { origin: 'https://stack.example.test', hostname: 'stack.example.test' },
            __HAPPIER_WEB_RUNTIME_CONFIG__: { serverUrl: 'https://server-override.example.test' },
        });

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://server-override.example.test');
    });

    it('falls back to an empty value when no server can be resolved', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('null');

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('');
    });

    it('uses window.location.origin on web when EXPO_PUBLIC_HAPPY_SERVER_URL is unset', async () => {
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        stubWebRuntime('https://stack.example.test');

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://stack.example.test');
    });

    it('uses EXPO_PUBLIC_HAPPIER_SERVER_URL as the canonical default server env var', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = 'https://canonical.example.test';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://legacy-happy.example.test';
        process.env.EXPO_PUBLIC_SERVER_URL = 'https://legacy-generic.example.test';

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://canonical.example.test');
    });

    it('uses EXPO_PUBLIC_HAPPY_SERVER_URL as a legacy alias when canonical env is unset', async () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://legacy-happy.example.test';
        process.env.EXPO_PUBLIC_SERVER_URL = 'https://legacy-generic.example.test';

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://legacy-happy.example.test');
    });

    it('uses EXPO_PUBLIC_SERVER_URL as a last-resort alias when canonical and happy env vars are unset', async () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        process.env.EXPO_PUBLIC_SERVER_URL = 'https://legacy-generic.example.test';

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('https://legacy-generic.example.test');
    });

    it('defaults to Happier Cloud on native when no server is configured', async () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;

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

    it('canonicalizes custom server URL by stripping query/hash while preserving userinfo', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');

        const { getServerUrl, setServerUrl } = await importFreshServerConfig();
        try {
            setServerUrl('https://admin:secret@custom.example.test:9443/path/?token=abc#frag');
            expect(getServerUrl()).toBe('https://admin:secret@custom.example.test:9443/path');
        } finally {
            setServerUrl(null);
        }
    });

    it('ignores stale sessionStorage server id override when that id is missing', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');

        const profiles = await (async () => {
            vi.resetModules();
            return await import('./serverProfiles');
        })();

        const created = profiles.upsertServerProfile({ serverUrl: 'https://device.example.test', name: 'Device' });
        profiles.setActiveServerId(created.id, { scope: 'device' });
        profiles.setActiveServerId('missing-server', { scope: 'tab' });

        const { getServerUrl } = await importFreshServerConfig();
        expect(getServerUrl()).toBe('https://device.example.test');
    });

    it('resetting a custom server returns to the stack default server (no built-in remote profile in stack context)', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013/';

        const { getServerUrl, isUsingCustomServer, setServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('http://localhost:3013');
        expect(isUsingCustomServer()).toBe(false);

        setServerUrl('https://custom.example.test/');
        expect(getServerUrl()).toBe('https://custom.example.test');
        expect(isUsingCustomServer()).toBe(true);

        // Reset should return to the stack default server.
        setServerUrl(null);
        expect(getServerUrl()).toBe('http://localhost:3013');
        expect(isUsingCustomServer()).toBe(false);

        const profiles = await import('./serverProfiles');
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'http://localhost:3013')).toBe(true);
    });

    it('rewrites stack-scoped private IP server URL to a loopback hostname on web', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://172.20.10.4:53288';
        stubWebRuntime('http://happier-dev.localhost:19364');

        const { getServerUrl } = await importFreshServerConfig();

        expect(getServerUrl()).toBe('http://happier-dev.localhost:53288');
    });
});
