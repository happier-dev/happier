import { afterEach, describe, expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';
import { scopedStorageId } from '@/utils/storageScope';

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

    afterEach(() => {
        vi.unstubAllGlobals();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('migrates legacy custom-server-url into a saved server profile and activates it', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        // Legacy server-config storage (native scope uses env)
        const legacy = new MMKV({ id: scopedStorageId('server-config', scope) });
        legacy.set('custom-server-url', 'https://legacy.example.test/');

        const profiles = await importFresh();

        const active = profiles.getActiveServerUrl();
        expect(active).toBe('https://legacy.example.test');

        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.id === 'official')).toBe(true);
        expect(all.some((p) => p.serverUrl === 'https://legacy.example.test')).toBe(true);
        expect(legacy.getString('custom-server-url')).toBeUndefined();
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
        profiles.setActiveServerId('official', { scope: 'tab' });

        expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('refuses to remove the official server profile', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();

        expect(() => profiles.removeServerProfile('official')).toThrow(/official/i);
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
});
