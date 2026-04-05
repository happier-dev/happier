import { afterEach, describe, expect, it, vi } from 'vitest';

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stubWebRuntime(origin: string) {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
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

async function importFresh() {
    vi.resetModules();
    return await import('./serverRuntime');
}

describe('serverRuntime', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    const previousServerContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    const previousCanonicalServerUrl = process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
    const previousServerUrl = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    const previousLegacyGenericServerUrl = process.env.EXPO_PUBLIC_SERVER_URL;
    const previousPreconfigured = process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
    const previousBuildFeaturesDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    afterEach(() => {
        vi.unstubAllGlobals();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        if (previousServerContext === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = previousServerContext;
        if (previousCanonicalServerUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        else process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = previousCanonicalServerUrl;
        if (previousServerUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = previousServerUrl;
        if (previousLegacyGenericServerUrl === undefined) delete process.env.EXPO_PUBLIC_SERVER_URL;
        else process.env.EXPO_PUBLIC_SERVER_URL = previousLegacyGenericServerUrl;
        if (previousPreconfigured === undefined) delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        else process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = previousPreconfigured;
        if (previousBuildFeaturesDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousBuildFeaturesDeny;
    });

    it('upserts a server profile without activating it', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('https://origin.example.test');

        const runtime = await importFresh();

        const active = runtime.upsertAndActivateServer({
            serverUrl: 'https://active.example.test',
            name: 'Active',
        });

        const candidate = runtime.upsertServerProfileOnly({
            serverUrl: 'https://candidate.example.test',
            name: 'Candidate',
        });

        expect(candidate.serverUrl).toBe('https://candidate.example.test');
        expect(runtime.getActiveServerSnapshot().serverId).toBe(active.id);
        expect(runtime.getActiveServerSnapshot().serverUrl).toBe('https://active.example.test');
    });
});
