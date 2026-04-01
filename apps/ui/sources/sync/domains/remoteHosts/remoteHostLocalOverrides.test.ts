import { afterEach, describe, expect, it, vi } from 'vitest';

function createMemoryStorage(): Readonly<{
    storage: { getString: (key: string) => string | null; set: (key: string, value: string) => void; delete: (key: string) => void };
    readRaw: (key: string) => string | null;
}> {
    const map = new Map<string, string>();
    return {
        storage: {
            getString: (key) => map.get(key) ?? null,
            set: (key, value) => {
                map.set(key, value);
            },
            delete: (key) => {
                map.delete(key);
            },
        },
        readRaw: (key) => map.get(key) ?? null,
    };
}

describe('remoteHostLocalOverrides', () => {
    const previousWindow = (globalThis as any).window;
    const previousDocument = (globalThis as any).document;

    afterEach(() => {
        (globalThis as any).window = previousWindow;
        (globalThis as any).document = previousDocument;
        vi.resetModules();
    });

    it('stores per-remoteHostId overrides and supports patch + delete', async () => {
        const { createRemoteHostLocalOverridesStore } = await import('./remoteHostLocalOverrides');
        const { storage, readRaw } = createMemoryStorage();
        const store = createRemoteHostLocalOverridesStore({ storage, persistKey: 'test' });

        expect(store.get('rh1')).toBeNull();
        store.patch('rh1', { identityFilePath: '/Users/me/.ssh/id_ed25519' });
        expect(store.get('rh1')).toEqual({ identityFilePath: '/Users/me/.ssh/id_ed25519' });

        store.patch('rh1', { sshConfigFilePath: '/Users/me/.ssh/config' });
        expect(store.get('rh1')).toEqual({
            identityFilePath: '/Users/me/.ssh/id_ed25519',
            sshConfigFilePath: '/Users/me/.ssh/config',
        });

        expect(readRaw('test')).toContain('rh1');

        store.delete('rh1');
        expect(store.get('rh1')).toBeNull();
        expect(readRaw('test')).toBeNull();
    });

    it('uses localStorage on web runtime for the default store helpers', async () => {
        const store = new Map<string, string>();
        const localStorage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
            removeItem: (key: string) => void store.delete(key),
        };

        const windowStub = { localStorage };
        (globalThis as any).window = windowStub;
        (globalThis as any).document = {};

        vi.resetModules();
        const mod = await import('./remoteHostLocalOverrides');
        mod.patchRemoteHostLocalOverrides('rh-web', { identityFilePath: '/tmp/id' });
        expect(mod.getRemoteHostLocalOverrides('rh-web')).toEqual({ identityFilePath: '/tmp/id' });
        mod.deleteRemoteHostLocalOverrides('rh-web');
        expect(mod.getRemoteHostLocalOverrides('rh-web')).toBeNull();
    });

    it('upserts local overrides and deletes them when empty', async () => {
        const store = new Map<string, string>();
        const localStorage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
            removeItem: (key: string) => void store.delete(key),
        };

        (globalThis as any).window = { localStorage };
        (globalThis as any).document = {};

        vi.resetModules();
        const mod = await import('./remoteHostLocalOverrides');

        mod.upsertRemoteHostLocalOverrides('rh-upsert', { identityFilePath: '/Users/me/.ssh/id_ed25519' });
        expect(mod.getRemoteHostLocalOverrides('rh-upsert')).toEqual({ identityFilePath: '/Users/me/.ssh/id_ed25519' });

        mod.upsertRemoteHostLocalOverrides('rh-upsert', { identityFilePath: '' });
        expect(mod.getRemoteHostLocalOverrides('rh-upsert')).toBeNull();
    });
});
