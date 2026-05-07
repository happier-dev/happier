import { describe, expect, it } from 'vitest';

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

describe('remote host trusted host-key store', () => {
    it('stores trust pins by normalized host, port, and algorithm', async () => {
        const loaded = await import('./trustedHostKeyStore').catch(() => null);
        expect(loaded).not.toBeNull();
        const { storage } = createMemoryStorage();
        const store = loaded!.createRemoteHostTrustedHostKeyStore({ storage, persistKey: 'test' });

        store.trust({
            host: ' EXAMPLE.test ',
            port: 2222,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:abc',
            remoteHostId: 'remote-1',
            nowMs: 100,
        });

        expect(store.get({
            host: 'example.TEST',
            port: 2222,
            algorithm: 'ssh-ed25519',
        })).toEqual(expect.objectContaining({
            hostLower: 'example.test',
            port: 2222,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:abc',
            remoteHostId: 'remote-1',
            trustedAtMs: 100,
            lastSeenAtMs: 100,
        }));
    });

    it('updates lastSeen without replacing original trust time', async () => {
        const loaded = await import('./trustedHostKeyStore').catch(() => null);
        expect(loaded).not.toBeNull();
        const { storage } = createMemoryStorage();
        const store = loaded!.createRemoteHostTrustedHostKeyStore({ storage, persistKey: 'test' });

        store.trust({
            host: 'example.test',
            port: 22,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:abc',
            nowMs: 100,
        });
        store.markSeen({
            host: 'example.test',
            port: 22,
            algorithm: 'ssh-ed25519',
            nowMs: 200,
        });

        expect(store.get({ host: 'example.test', port: 22, algorithm: 'ssh-ed25519' })).toEqual(expect.objectContaining({
            trustedAtMs: 100,
            lastSeenAtMs: 200,
        }));
    });

    it('deletes individual trust pins and removes empty persisted state', async () => {
        const loaded = await import('./trustedHostKeyStore').catch(() => null);
        expect(loaded).not.toBeNull();
        const { storage, readRaw } = createMemoryStorage();
        const store = loaded!.createRemoteHostTrustedHostKeyStore({ storage, persistKey: 'test' });

        store.trust({
            host: 'example.test',
            port: 22,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:abc',
            nowMs: 100,
        });
        expect(readRaw('test')).toContain('example.test');

        store.delete({ host: 'example.test', port: 22, algorithm: 'ssh-ed25519' });

        expect(store.readAll()).toEqual([]);
        expect(readRaw('test')).toBeNull();
    });

    it('clears every trusted host key pin', async () => {
        const loaded = await import('./trustedHostKeyStore').catch(() => null);
        expect(loaded).not.toBeNull();
        const { storage, readRaw } = createMemoryStorage();
        const store = loaded!.createRemoteHostTrustedHostKeyStore({ storage, persistKey: 'test' });

        store.trust({
            host: 'first.example.test',
            port: 22,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:first',
            nowMs: 100,
        });
        store.trust({
            host: 'second.example.test',
            port: 2222,
            algorithm: 'ssh-rsa',
            fingerprintSha256: 'SHA256:second',
            nowMs: 200,
        });

        store.clear();

        expect(store.readAll()).toEqual([]);
        expect(readRaw('test')).toBeNull();
    });
});
