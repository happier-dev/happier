import { describe, expect, it, vi } from 'vitest';

import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import * as platformDigest from '@/platform/digest';

import { PLUGIN_UI_PERSISTENT_ARTIFACT_WEB_BYTE_BUDGET } from './artifactByteCache';
import { createBrowserPluginUiPersistentArtifactStore } from './artifactByteCache.browser';

const CACHE_NAME = 'happier-plugin-ui-artifacts-v1';

function createMemoryCacheStorage(options: Readonly<{ failDelete?: boolean }> = {}): CacheStorage {
    const stores = new Map<string, Map<string, Response>>();
    const requestUrl = (request: RequestInfo | URL): string => {
        if (typeof request === 'string') return request;
        return request instanceof URL ? request.href : request.url;
    };
    return {
        open: async (name) => {
            const records = stores.get(name) ?? new Map<string, Response>();
            stores.set(name, records);
            return {
                match: async (request: RequestInfo | URL) => records.get(requestUrl(request))?.clone(),
                put: async (request: RequestInfo | URL, response: Response) => {
                    records.set(requestUrl(request), response.clone());
                },
                delete: async (request: RequestInfo | URL) => {
                    if (options.failDelete) throw new Error('simulated cache deletion failure');
                    return records.delete(requestUrl(request));
                },
                keys: async () => [...records.keys()].map((url) => new Request(url)),
            } as unknown as Cache;
        },
        delete: async (name) => stores.delete(name),
        has: async (name) => stores.has(name),
        keys: async () => [...stores.keys()],
        match: async () => undefined,
    };
}

describe('browser Plugin UI persistent artifact store', () => {
    it('restores a committed record and removes only the selected Account', async () => {
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage);
        const bytes = new TextEncoder().encode('// browser persistent bytes');
        const artifactDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const base = {
            releaseVersion: '2.0.0',
            pluginId: 'acme.plugin',
            contributionId: 'surface',
            tier: 'reactNative' as const,
            platform: 'web',
            artifactDigest,
        };
        const accountA = { ...base, accountScope: { serverId: 'server-a', accountId: 'account-a' } };
        const accountB = { ...base, accountScope: { serverId: 'server-a', accountId: 'account-b' } };
        const graph = (persistentIdentity: typeof accountA) => ({
            persistentIdentity,
            bytes,
            entryRelativePath: 'entry.js',
            files: [{ relativePath: 'entry.js', digest: artifactDigest, byteSize: bytes.byteLength, bytes }],
        });
        await store.write(graph(accountA));
        await store.write(graph(accountB));

        await expect(store.read(accountA)).resolves.toMatchObject({ bytes });
        await store.removeAccount(accountA.accountScope);

        await expect(store.read(accountA)).resolves.toBeNull();
        await expect(store.read(accountB)).resolves.toMatchObject({ bytes });
    });

    it('evicts an incomplete committed record instead of retaining a permanent cache miss', async () => {
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage);
        const entryBytes = new TextEncoder().encode('// entry');
        const chunkBytes = new TextEncoder().encode('// chunk');
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            releaseVersion: '2.0.0',
            pluginId: 'acme.plugin',
            contributionId: 'surface',
            tier: 'reactNative' as const,
            platform: 'web',
            artifactDigest: computePluginUiArtifactSha256DigestV1(entryBytes),
        };
        await store.write({
            persistentIdentity,
            bytes: entryBytes,
            entryRelativePath: 'entry.js',
            files: [
                {
                    relativePath: 'entry.js',
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                    bytes: entryBytes,
                },
                {
                    relativePath: 'chunk.js',
                    digest: computePluginUiArtifactSha256DigestV1(chunkBytes),
                    byteSize: chunkBytes.byteLength,
                    bytes: chunkBytes,
                },
            ],
        });
        const cache = await cacheStorage.open('happier-plugin-ui-artifacts-v1');
        const chunkRequest = (await cache.keys()).find((request) => request.url.endsWith('/file/1'));
        if (!chunkRequest) throw new Error('Fixture must contain the second cached file.');
        await cache.delete(chunkRequest);

        await expect(store.read(persistentIdentity)).resolves.toBeNull();
        await expect(cache.keys()).resolves.toEqual([]);
    });

    it('evicts a record whose manifest gives a file a non-canonical digest', async () => {
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage);
        const bytes = new TextEncoder().encode('// browser persistent bytes');
        const artifactDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            releaseVersion: '2.0.0',
            pluginId: 'acme.plugin',
            contributionId: 'surface',
            tier: 'reactNative' as const,
            platform: 'web',
            artifactDigest,
        };
        await store.write({
            persistentIdentity,
            bytes,
            entryRelativePath: 'entry.js',
            files: [{ relativePath: 'entry.js', digest: artifactDigest, byteSize: bytes.byteLength, bytes }],
        });
        const cache = await cacheStorage.open('happier-plugin-ui-artifacts-v1');
        const manifestRequest = (await cache.keys()).find((request) => request.url.endsWith('/manifest'));
        if (!manifestRequest) throw new Error('Fixture must contain the persistent manifest.');
        const manifestResponse = await cache.match(manifestRequest);
        if (!manifestResponse) throw new Error('Fixture must contain the persistent manifest response.');
        const writtenManifest = await manifestResponse.text();
        const malformedManifest = writtenManifest.replace(
            `"digest":"${artifactDigest}"`,
            '"digest":"sha256:not-a-digest"',
        );
        expect(malformedManifest).not.toBe(writtenManifest);
        await cache.put(manifestRequest, new Response(malformedManifest, {
            headers: { 'content-type': 'application/json' },
        }));

        await expect(store.read(persistentIdentity)).resolves.toBeNull();
        await expect(cache.keys()).resolves.toEqual([]);
    });

    it('reads committed internal bytes without hashing or evicting them', async () => {
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage);
        const bytes = new TextEncoder().encode('// browser persistent bytes');
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            artifactDigest: computePluginUiArtifactSha256DigestV1(bytes),
        };
        await store.write({
            persistentIdentity,
            bytes,
            entryRelativePath: 'entry.js',
            files: [{
                relativePath: 'entry.js',
                digest: persistentIdentity.artifactDigest,
                byteSize: bytes.byteLength,
                bytes,
            }],
        });
        const cache = await cacheStorage.open(CACHE_NAME);
        const member = (await cache.keys()).find((request) => request.url.endsWith('/file/0'));
        if (!member) throw new Error('Fixture must contain the cached member.');
        const hashing = vi.spyOn(platformDigest, 'digest');
        try {
            await expect(store.read(persistentIdentity)).resolves.toMatchObject({ bytes });
            await expect(store.read(persistentIdentity)).resolves.toMatchObject({ bytes });
            const updatedBytes = new Uint8Array(bytes.byteLength).fill(120);
            await cache.put(member, new Response(updatedBytes));
            await expect(store.read(persistentIdentity)).resolves.toMatchObject({ bytes: updatedBytes });
            expect(hashing).toHaveBeenCalledTimes(0);
            expect(await cache.keys()).toHaveLength(2);
        } finally { hashing.mockRestore(); }
    });
});

/**
 * PEP-ARTIFACTS r0.19 / PEP-MASTER r0.146: one global cross-Account byte-LRU at
 * this physical byte owner. The fixtures below use a supplied budget so the
 * exact/+1 boundary is provable without allocating the shipped 192 MiB.
 */
describe('browser Plugin UI persistent artifact byte budget', () => {
    const payloadFor = (marker: string) => new TextEncoder().encode(`// persistent bytes ${marker} padding`);

    function identityFor(input: Readonly<{ accountId: string; pluginId: string; bytes: Uint8Array }>) {
        return {
            accountScope: { serverId: 'server-a', accountId: input.accountId },
            releaseVersion: '2.0.0',
            pluginId: input.pluginId,
            contributionId: 'surface',
            tier: 'reactNative' as const,
            platform: 'web',
            artifactDigest: computePluginUiArtifactSha256DigestV1(input.bytes),
        };
    }

    function graphFor(persistentIdentity: ReturnType<typeof identityFor>, bytes: Uint8Array) {
        return {
            persistentIdentity,
            bytes,
            entryRelativePath: 'entry.js',
            files: [{
                relativePath: 'entry.js',
                digest: computePluginUiArtifactSha256DigestV1(bytes),
                byteSize: bytes.byteLength,
                bytes,
            }],
        };
    }

    /** The charge one single-file record adds: payload plus its persisted manifest. */
    async function measureChargedBytes(bytes: Uint8Array): Promise<number> {
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage);
        const identity = identityFor({ accountId: 'account-a', pluginId: 'acme.aa', bytes });
        await store.write(graphFor(identity, bytes));
        const cache = await cacheStorage.open(CACHE_NAME);
        const manifestRequest = (await cache.keys()).find((request) => request.url.endsWith('/manifest'));
        if (!manifestRequest) throw new Error('Fixture must persist a manifest.');
        const manifestResponse = await cache.match(manifestRequest);
        if (!manifestResponse) throw new Error('Fixture must persist a manifest body.');
        const metadataByteSize = new TextEncoder().encode(await manifestResponse.text()).byteLength;
        return bytes.byteLength + metadataByteSize;
    }

    it('enforces the shipped 192 MiB budget by default', () => {
        expect(PLUGIN_UI_PERSISTENT_ARTIFACT_WEB_BYTE_BUDGET).toBe(192 * 1024 * 1024);
    });

    it('evicts the least recently accessed record across Accounts, never the Account that was written first', async () => {
        const bytesA = payloadFor('aa');
        const bytesB = payloadFor('bb');
        const bytesC = payloadFor('cc');
        const charged = await measureChargedBytes(bytesA);
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage, {
            budgetBytes: charged * 2,
        });
        const first = identityFor({ accountId: 'account-a', pluginId: 'acme.aa', bytes: bytesA });
        const second = identityFor({ accountId: 'account-b', pluginId: 'acme.bb', bytes: bytesB });
        const third = identityFor({ accountId: 'account-a', pluginId: 'acme.cc', bytes: bytesC });

        await store.write(graphFor(first, bytesA));
        await store.write(graphFor(second, bytesB));
        // Both fit exactly at the budget; neither Account is privileged.
        await expect(store.read(first)).resolves.toMatchObject({ bytes: bytesA });
        await expect(store.read(second)).resolves.toMatchObject({ bytes: bytesB });

        // A successful read of the first record refreshes its ordering, so the
        // second record is now the least recently accessed entry.
        await store.read(first);
        await store.write(graphFor(third, bytesC));

        await expect(store.read(second)).resolves.toBeNull();
        await expect(store.read(first)).resolves.toMatchObject({ bytes: bytesA });
        await expect(store.read(third)).resolves.toMatchObject({ bytes: bytesC });
    });

    it('charges persisted metadata to the same total as the payload', async () => {
        const bytesA = payloadFor('aa');
        const bytesB = payloadFor('bb');
        const charged = await measureChargedBytes(bytesA);
        const cacheStorage = createMemoryCacheStorage();
        // One byte below the two-record total: payload alone would still fit, so
        // only metadata charging can force the eviction.
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage, {
            budgetBytes: charged * 2 - 1,
        });
        const first = identityFor({ accountId: 'account-a', pluginId: 'acme.aa', bytes: bytesA });
        const second = identityFor({ accountId: 'account-b', pluginId: 'acme.bb', bytes: bytesB });

        await store.write(graphFor(first, bytesA));
        await store.write(graphFor(second, bytesB));

        expect(charged * 2 - 1).toBeGreaterThan(bytesA.byteLength + bytesB.byteLength);
        await expect(store.read(first)).resolves.toBeNull();
        await expect(store.read(second)).resolves.toMatchObject({ bytes: bytesB });
    });

    it('charges a replaced record once instead of accumulating its predecessor', async () => {
        const bytesA = payloadFor('aa');
        const bytesB = payloadFor('bb');
        const charged = await measureChargedBytes(bytesA);
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage, {
            budgetBytes: charged * 2,
        });
        const first = identityFor({ accountId: 'account-a', pluginId: 'acme.aa', bytes: bytesA });
        const second = identityFor({ accountId: 'account-b', pluginId: 'acme.bb', bytes: bytesB });

        await store.write(graphFor(first, bytesA));
        await store.write(graphFor(first, bytesA));
        await store.write(graphFor(first, bytesA));
        await store.write(graphFor(second, bytesB));

        await expect(store.read(first)).resolves.toMatchObject({ bytes: bytesA });
        await expect(store.read(second)).resolves.toMatchObject({ bytes: bytesB });
    });

    it('serializes concurrent mutations so two Accounts cannot overrun the one physical budget', async () => {
        const bytesA = payloadFor('aa');
        const bytesB = payloadFor('bb');
        const charged = await measureChargedBytes(bytesA);
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage, { budgetBytes: charged });
        const first = identityFor({ accountId: 'account-a', pluginId: 'acme.aa', bytes: bytesA });
        const second = identityFor({ accountId: 'account-b', pluginId: 'acme.bb', bytes: bytesB });

        await Promise.all([
            store.write(graphFor(first, bytesA)),
            store.write(graphFor(second, bytesB)),
        ]);

        const cache = await cacheStorage.open(CACHE_NAME);
        const manifests = (await cache.keys()).filter((request) => request.url.endsWith('/manifest'));
        expect(manifests).toHaveLength(1);
    });

    it('keeps an artifact larger than the whole budget out of persistent storage without leaving partial members', async () => {
        const bytes = payloadFor('aa');
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage, {
            budgetBytes: bytes.byteLength,
        });
        const identity = identityFor({ accountId: 'account-a', pluginId: 'acme.aa', bytes });

        // The caller's already-verified lease keeps serving this load: refusing
        // adoption is a typed disposition, not a failure.
        await expect(store.write(graphFor(identity, bytes))).resolves.toBe('notPersistedOversize');

        await expect(store.read(identity)).resolves.toBeNull();
        const cache = await cacheStorage.open(CACHE_NAME);
        await expect(cache.keys()).resolves.toEqual([]);
    });

    it('does not commit another record when required eviction fails', async () => {
        const bytesA = payloadFor('aa');
        const bytesB = payloadFor('bb');
        const charged = await measureChargedBytes(bytesA);
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage, { budgetBytes: charged });
        const first = identityFor({ accountId: 'account-a', pluginId: 'acme.aa', bytes: bytesA });
        const second = identityFor({ accountId: 'account-b', pluginId: 'acme.bb', bytes: bytesB });
        await store.write(graphFor(first, bytesA));

        const failingStorage = createMemoryCacheStorage({ failDelete: true });
        const failingCache = await failingStorage.open(CACHE_NAME);
        const sourceCache = await cacheStorage.open(CACHE_NAME);
        for (const request of await sourceCache.keys()) {
            const response = await sourceCache.match(request);
            if (response) await failingCache.put(request, response);
        }
        const failingStore = createBrowserPluginUiPersistentArtifactStore(failingStorage, { budgetBytes: charged });

        await expect(failingStore.write(graphFor(second, bytesB))).rejects.toThrow('simulated cache deletion failure');
        await expect(failingStore.read(second)).resolves.toBeNull();
    });

    it('reclaims an orphaned record with no commit marker when the next record is written', async () => {
        const bytesA = payloadFor('aa');
        const bytesB = payloadFor('bb');
        const charged = await measureChargedBytes(bytesA);
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage, {
            budgetBytes: charged * 2,
        });
        const first = identityFor({ accountId: 'account-a', pluginId: 'acme.aa', bytes: bytesA });
        const second = identityFor({ accountId: 'account-b', pluginId: 'acme.bb', bytes: bytesB });
        await store.write(graphFor(first, bytesA));
        const cache = await cacheStorage.open(CACHE_NAME);
        const manifestRequest = (await cache.keys()).find((request) => request.url.endsWith('/manifest'));
        if (!manifestRequest) throw new Error('Fixture must persist a manifest.');
        await cache.delete(manifestRequest);

        expect((await cache.keys()).length).toBe(1);

        await store.write(graphFor(second, bytesB));

        // Only the newly committed record survives: an uncommittable member is
        // reclaimed rather than charged against the budget forever.
        expect((await cache.keys()).length).toBe(2);
        await expect(store.read(first)).resolves.toBeNull();
        await expect(store.read(second)).resolves.toMatchObject({ bytes: bytesB });
    });

    it('retains another Account\'s inert bytes instead of deleting them on a switch-scoped write', async () => {
        const bytesA = payloadFor('aa');
        const bytesB = payloadFor('bb');
        const charged = await measureChargedBytes(bytesA);
        const cacheStorage = createMemoryCacheStorage();
        const store = createBrowserPluginUiPersistentArtifactStore(cacheStorage, {
            budgetBytes: charged * 4,
        });
        const accountA = identityFor({ accountId: 'account-a', pluginId: 'acme.aa', bytes: bytesA });
        const accountB = identityFor({ accountId: 'account-b', pluginId: 'acme.bb', bytes: bytesB });

        await store.write(graphFor(accountA, bytesA));
        await store.write(graphFor(accountB, bytesB));

        // A -> B -> A: only logout/forget deletes, so returning to Account A still reuses its bytes.
        await expect(store.read(accountA)).resolves.toMatchObject({ bytes: bytesA });
        await expect(store.read(accountB)).resolves.toMatchObject({ bytes: bytesB });
    });
});
