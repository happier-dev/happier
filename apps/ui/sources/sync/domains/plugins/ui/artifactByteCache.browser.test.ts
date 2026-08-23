import { describe, expect, it } from 'vitest';

import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

import { createBrowserPluginUiPersistentArtifactStore } from './artifactByteCache.browser';

function createMemoryCacheStorage(): CacheStorage {
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
                delete: async (request: RequestInfo | URL) => records.delete(requestUrl(request)),
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
});
