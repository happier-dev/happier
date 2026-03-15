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
});
