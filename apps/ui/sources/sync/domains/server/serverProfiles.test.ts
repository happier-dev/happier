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

async function importFresh() {
    vi.resetModules();
    return await import('./serverProfiles');
}

describe('serverProfiles', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    const previousServerContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    const previousServerUrl = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;

    afterEach(() => {
        vi.unstubAllGlobals();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        if (previousServerContext === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = previousServerContext;
        if (previousServerUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = previousServerUrl;
    });

    it('prefers sessionStorage activeServerId on web over the device default', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();

        const created = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        profiles.setActiveServerId(created.id, { scope: 'device' });
        profiles.setActiveServerId('cloud', { scope: 'tab' });

        expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('refuses to remove the Happier Cloud server profile', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();

        expect(() => profiles.removeServerProfile('cloud')).toThrow(/happier cloud/i);
    });

    it('derives deterministic filesystem-safe ids from server URLs', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const one = profiles.upsertServerProfile({ serverUrl: 'https://Example.COM:8443/' });
        const two = profiles.upsertServerProfile({ serverUrl: 'https://example.com:8443' });

        expect(one.id).toBe(two.id);
        expect(one.id).toMatch(/^[a-z0-9._-]+$/);
    });

    it('can rename a server profile without changing its id', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = profiles.upsertServerProfile({ serverUrl: 'https://rename.example.test', name: 'Before' });
        profiles.renameServerProfile(created.id, 'After');

        const list = profiles.listServerProfiles();
        const updated = list.find((p) => p.id === created.id);
        expect(updated?.name).toBe('After');
    });

    it('does not auto-seed Happier Cloud in stack context', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';

        const profiles = await importFresh();
        const created = profiles.upsertServerProfile({
            serverUrl: 'https://stack.example.test',
            name: 'Stack',
            kind: 'stack',
            managed: true,
            stableKey: 'dev-stack',
        });
        profiles.setActiveServerId(created.id, { scope: 'device' });

        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.id === 'cloud')).toBe(false);
        expect(profiles.getActiveServerUrl()).toBe('https://stack.example.test');
    });

    it('allows manually adding the Happier Cloud server in stack context', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';

        const profiles = await importFresh();
        const cloud = profiles.upsertServerProfile({ serverUrl: 'https://api.happier.dev', name: 'Whatever' });

        // Stack context should not auto-seed Cloud, but if the user explicitly adds it, we keep it and normalize to cloud id.
        expect(cloud.id).toBe('cloud');
        expect(cloud.name).toBe('Happier Cloud');
        expect(profiles.listServerProfiles().some((p) => p.id === 'cloud')).toBe(true);
    });

    it('updates managed stack profile in-place when stableKey is reused', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const first = profiles.upsertServerProfile({
            serverUrl: 'http://127.0.0.1:3010',
            name: 'dev',
            kind: 'stack',
            managed: true,
            stableKey: 'dev-stack',
        });
        const second = profiles.upsertServerProfile({
            serverUrl: 'http://127.0.0.1:4010',
            name: 'dev',
            kind: 'stack',
            managed: true,
            stableKey: 'dev-stack',
        });

        expect(second.id).toBe(first.id);
        expect(second.serverUrl).toBe('http://127.0.0.1:4010');
        expect(profiles.listServerProfiles().filter((p) => p.stableKey === 'dev-stack')).toHaveLength(1);
    });

    it('dedupes localhost and 127.0.0.1 loopback URLs into one profile', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const first = profiles.upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'local-a' });
        const second = profiles.upsertServerProfile({ serverUrl: 'http://127.0.0.1:3012', name: 'local-b' });

        expect(second.id).toBe(first.id);
        expect(second.name).toBe('local-a');
        expect(second.serverUrl).toBe('http://localhost:3012');
        expect(profiles.listServerProfiles().filter((p) => p.id === first.id)).toHaveLength(1);
    });

    it('reset-to-default targets the stack env server in stack context (no cloud profile)', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        const profiles = await importFresh();
        const other = profiles.upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });

        const resetId = profiles.getResetToDefaultServerId();
        expect(resetId).not.toBe('cloud');

        profiles.setActiveServerId(resetId, { scope: 'device' });
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3013');
    });

    it('reset-to-default targets the cloud profile outside stack context', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = '';

        const profiles = await importFresh();
        expect(profiles.getResetToDefaultServerId()).toBe('cloud');
    });

    it('seeds the stack env server profile on load in stack context (and does not include Happier Cloud)', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.id === 'cloud')).toBe(false);
        expect(all.some((p) => p.serverUrl === 'http://localhost:3013')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3013');
    });

    it('detects the Happier Cloud server id via isCloudServerProfileId', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        expect(profiles.isCloudServerProfileId('cloud')).toBe(true);
        expect(profiles.isCloudServerProfileId(' cloud ')).toBe(true);
        expect(profiles.isCloudServerProfileId('legacy')).toBe(false);
        expect(profiles.isCloudServerProfileId('not-cloud')).toBe(false);
        expect(profiles.isCloudServerProfileId('')).toBe(false);
    });

    it('does not throw when setting active server id to an unknown value (ignores request)', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        const profiles = await importFresh();
        const other = profiles.upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });

        expect(() => profiles.setActiveServerId('missing', { scope: 'device' })).not.toThrow();
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3012');
    });
});
