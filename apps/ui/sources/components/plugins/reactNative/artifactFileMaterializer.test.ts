import { describe, expect, it, vi } from 'vitest';

import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

import {
    createReactNativeInstalledArtifactDiskGc,
    createReactNativeInstalledArtifactFileMaterializer,
    createReactNativePersistentArtifactStore,
    resolveMaterializedArtifactDirectoryName,
} from './artifactFileMaterializer';
import {
    createPluginReactNativeBundleCache,
    type PluginReactNativeBundleCacheIdentity,
} from './bundleCache';

function buildIdentity(overrides: Partial<PluginReactNativeBundleCacheIdentity> = {}): PluginReactNativeBundleCacheIdentity {
    const bytes = new Uint8Array([47, 47, 32, 105, 110, 115, 116, 97, 108, 108, 101, 100]);
    return {
        pluginId: 'acme/preview',
        contributionId: '../native:preview',
        artifactDigest: computePluginUiArtifactSha256DigestV1(bytes),
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.2.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '55.0.14',
        hermesVersion: '0.15.0',
        platform: 'ios',
        channel: 'internal',
        nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        projectionGeneration: 12,
        ...overrides,
    };
}

function createFakeExpoFileSystem(cacheUri = 'file:///cache/') {
    const files = new Map<string, Uint8Array>();
    const writes: string[] = [];
    const directoryCreates: unknown[] = [];

    class Directory {
        readonly uri: string;

        constructor(...uris: Array<{ uri: string } | string>) {
            this.uri = joinUris(uris);
        }

        create(options?: unknown): void {
            directoryCreates.push(options);
        }
    }

    class File {
        readonly uri: string;

        constructor(...uris: Array<{ uri: string } | string>) {
            this.uri = joinUris(uris);
        }

        get exists(): boolean {
            return files.has(this.uri);
        }

        get size(): number {
            return files.get(this.uri)?.byteLength ?? 0;
        }

        async bytes(): Promise<Uint8Array> {
            return new Uint8Array(files.get(this.uri) ?? []);
        }

        write(bytes: Uint8Array): void {
            files.set(this.uri, new Uint8Array(bytes));
            writes.push(this.uri);
        }

        delete(): void {
            files.delete(this.uri);
        }
    }

    return {
        fileSystem: {
            Paths: { cache: new Directory(cacheUri) },
            Directory,
            File,
        },
        files,
        writes,
        directoryCreates,
    };
}

function createFakeExpoFileSystemWithDirectoryDeletion(
    cacheUri = 'file:///cache/',
    options: Readonly<{ failDirectoryDeletion?: boolean }> = {},
) {
    const files = new Map<string, Uint8Array>();
    const writes: string[] = [];
    const directoryDeletes: string[] = [];

    class Directory {
        readonly uri: string;

        constructor(...uris: Array<{ uri: string } | string>) {
            this.uri = joinUris(uris);
        }

        get exists(): boolean {
            const prefix = `${this.uri.replace(/\/+$/u, '')}/`;
            return [...files.keys()].some((key) => key.startsWith(prefix));
        }

        create(): void {}

        list(): Directory[] {
            const prefix = `${this.uri.replace(/\/+$/u, '')}/`;
            const childNames = new Set<string>();
            for (const path of files.keys()) {
                if (!path.startsWith(prefix)) continue;
                const childName = path.slice(prefix.length).split('/')[0];
                if (childName) childNames.add(childName);
            }
            return [...childNames].map((childName) => new Directory(this, childName));
        }

        delete(): void {
            if (options.failDirectoryDeletion) throw new Error('simulated directory deletion failure');
            const prefix = `${this.uri.replace(/\/+$/u, '')}/`;
            for (const key of [...files.keys()]) {
                if (key.startsWith(prefix)) {
                    files.delete(key);
                }
            }
            directoryDeletes.push(this.uri);
        }
    }

    class File {
        readonly uri: string;

        constructor(...uris: Array<{ uri: string } | string>) {
            this.uri = joinUris(uris);
        }

        get exists(): boolean {
            return files.has(this.uri);
        }

        get size(): number {
            return files.get(this.uri)?.byteLength ?? 0;
        }

        async bytes(): Promise<Uint8Array> {
            return new Uint8Array(files.get(this.uri) ?? []);
        }

        write(bytes: Uint8Array): void {
            files.set(this.uri, new Uint8Array(bytes));
            writes.push(this.uri);
        }

        delete(): void {
            files.delete(this.uri);
        }
    }

    return {
        fileSystem: {
            Paths: { cache: new Directory(cacheUri) },
            Directory,
            File,
        },
        files,
        writes,
        directoryDeletes,
    };
}

function joinUris(uris: Array<{ uri: string } | string>): string {
    return uris
        .map((uri) => typeof uri === 'string' ? uri : uri.uri)
        .filter(Boolean)
        .reduce((left, right) => {
            if (!left) return right;
            return `${left.replace(/\/+$/u, '')}/${right.replace(/^\/+/u, '')}`;
        }, '');
}

describe('React Native installed artifact file materializer', () => {
    it('uses the same materialized path across compatibility and projection changes for identical bytes', () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const artifactDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const before = buildIdentity({ artifactDigest });
        const after = buildIdentity({
            artifactDigest,
            hostAppVersion: '9.0.0',
            hostUiApiVersion: '4.0.0',
            projectionGeneration: 999,
            nativeCapabilitiesDigest: computePluginUiArtifactSha256DigestV1(new Uint8Array([15])),
        });

        expect(resolveMaterializedArtifactDirectoryName(after))
            .toBe(resolveMaterializedArtifactDirectoryName(before));
    });

    it('materializes verified bytes to a stable sanitized file URL and avoids a needless rewrite', async () => {
        const bytes = new Uint8Array([47, 47, 32, 105, 110, 115, 116, 97, 108, 108, 101, 100]);
        const identity = buildIdentity({ artifactDigest: computePluginUiArtifactSha256DigestV1(bytes) });
        const fake = createFakeExpoFileSystem();
        const materialize = createReactNativeInstalledArtifactFileMaterializer({
            fileSystem: fake.fileSystem,
        });

        const firstUrl = await materialize({
            identity,
            bytes,
            scriptId: 'happier-installed-artifact:acme/preview:../native:preview:ios:internal',
        });
        const secondUrl = await materialize({
            identity,
            bytes,
            scriptId: 'happier-installed-artifact:acme/preview:../native:preview:ios:internal',
        });

        expect(firstUrl).toBe(secondUrl);
        expect(firstUrl).toMatch(/^file:\/\/\/cache\/happier-rn-installed-artifacts-v1\//u);
        expect(firstUrl).not.toContain('acme/preview');
        expect(firstUrl).not.toContain('native:preview');
        expect(firstUrl).not.toContain('internal');
        expect(fake.writes).toEqual([firstUrl]);
        expect(fake.directoryCreates).toContainEqual({ intermediates: true, idempotent: true });
    });

    it('keeps colliding raw path-like identities in separate cache files', async () => {
        const bytes = new Uint8Array([47, 42, 32, 98, 117, 110, 100, 108, 101, 32, 42, 47]);
        const digest = computePluginUiArtifactSha256DigestV1(bytes);
        const fake = createFakeExpoFileSystem();
        const materialize = createReactNativeInstalledArtifactFileMaterializer({
            fileSystem: fake.fileSystem,
        });

        const firstUrl = await materialize({
            identity: buildIdentity({
                pluginId: 'acme/a',
                contributionId: 'b',
                artifactDigest: digest,
            }),
            bytes,
            scriptId: 'script:one',
        });
        const secondUrl = await materialize({
            identity: buildIdentity({
                pluginId: 'acme',
                contributionId: 'a/b',
                artifactDigest: digest,
            }),
            bytes,
            scriptId: 'script:one',
        });

        expect(firstUrl).not.toBe(secondUrl);
        expect([...fake.files.keys()].sort()).toEqual([firstUrl, secondUrl].sort());
    });

    it('rewrites an existing same-size cache file when the digest no longer matches', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const staleSameSizeBytes = new Uint8Array([4, 3, 2, 1]);
        const identity = buildIdentity({ artifactDigest: computePluginUiArtifactSha256DigestV1(bytes) });
        const fake = createFakeExpoFileSystem();
        const materialize = createReactNativeInstalledArtifactFileMaterializer({
            fileSystem: fake.fileSystem,
        });

        const url = await materialize({ identity, bytes, scriptId: 'script:rewrite' });
        fake.files.set(url, staleSameSizeBytes);

        await expect(materialize({ identity, bytes, scriptId: 'script:rewrite' })).resolves.toBe(url);

        expect(fake.writes).toEqual([url, url]);
        expect(fake.files.get(url)).toEqual(bytes);
    });

    it('fails closed instead of returning non-file cache URLs', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const identity = buildIdentity({ artifactDigest: computePluginUiArtifactSha256DigestV1(bytes) });
        const fake = createFakeExpoFileSystem('https://cache.example.invalid/');
        const materialize = createReactNativeInstalledArtifactFileMaterializer({
            fileSystem: fake.fileSystem,
        });

        await expect(materialize({ identity, bytes, scriptId: 'script:remote' }))
            .rejects.toThrow('must materialize to a file:// URL');
        expect(fake.writes).toEqual([]);
    });

    it('rejects bytes that do not match the verified cache identity digest', async () => {
        const fake = createFakeExpoFileSystem();
        const materialize = createReactNativeInstalledArtifactFileMaterializer({
            fileSystem: fake.fileSystem,
        });

        await expect(materialize({
            identity: buildIdentity({ artifactDigest: computePluginUiArtifactSha256DigestV1(new Uint8Array([9])) }),
            bytes: new Uint8Array([1]),
            scriptId: 'script:digest-mismatch',
        })).rejects.toThrow('digest_mismatch');
        expect(fake.writes).toEqual([]);
    });
});

describe('React Native persistent artifact store', () => {
    it('commits the manifest last and restores bytes after a new store instance starts', async () => {
        const fake = createFakeExpoFileSystemWithDirectoryDeletion();
        const bytes = new TextEncoder().encode('// persistent native bytes');
        const artifactDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            releaseVersion: '1.2.3',
            pluginId: 'acme.plugin',
            contributionId: 'native',
            tier: 'reactNative' as const,
            platform: 'ios',
            artifactDigest,
        };
        const first = createReactNativePersistentArtifactStore({ fileSystem: fake.fileSystem });

        await first.write({
            persistentIdentity,
            bytes,
            entryRelativePath: 'entry.js',
            files: [{ relativePath: 'entry.js', digest: artifactDigest, byteSize: bytes.byteLength, bytes }],
        });

        expect(fake.writes.at(-1)).toMatch(/\/record\.v1\.json$/u);
        const restarted = createReactNativePersistentArtifactStore({ fileSystem: fake.fileSystem });
        await expect(restarted.read(persistentIdentity)).resolves.toMatchObject({
            persistentIdentity,
            bytes,
        });
    });

    it('retires the commit marker before a failed physical deletion so restart cannot restore bytes', async () => {
        const fake = createFakeExpoFileSystemWithDirectoryDeletion('file:///cache/', {
            failDirectoryDeletion: true,
        });
        const bytes = new TextEncoder().encode('// retired persistent native bytes');
        const artifactDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            releaseVersion: '1.2.3',
            pluginId: 'acme.plugin',
            contributionId: 'native',
            tier: 'reactNative' as const,
            platform: 'ios',
            artifactDigest,
        };
        const first = createReactNativePersistentArtifactStore({ fileSystem: fake.fileSystem });
        await first.write({
            persistentIdentity,
            bytes,
            entryRelativePath: 'entry.js',
            files: [{ relativePath: 'entry.js', digest: artifactDigest, byteSize: bytes.byteLength, bytes }],
        });

        await expect(first.remove(persistentIdentity))
            .rejects.toThrow('plugin_ui_artifact_cache_delete_failed');

        const restarted = createReactNativePersistentArtifactStore({ fileSystem: fake.fileSystem });
        await expect(restarted.read(persistentIdentity)).resolves.toBeNull();
        expect([...fake.files.keys()].some((path) => path.endsWith('/record.v1.json'))).toBe(false);
        expect(fake.files.size).toBeGreaterThan(0);
    });

    it('retires every Account commit marker before failed Account directory deletion', async () => {
        const fake = createFakeExpoFileSystemWithDirectoryDeletion('file:///cache/', {
            failDirectoryDeletion: true,
        });
        const bytes = new TextEncoder().encode('// retired Account bytes');
        const artifactDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            releaseVersion: '1.2.3',
            pluginId: 'acme.plugin',
            contributionId: 'native',
            tier: 'reactNative' as const,
            platform: 'ios',
            artifactDigest,
        };
        const first = createReactNativePersistentArtifactStore({ fileSystem: fake.fileSystem });
        await first.write({
            persistentIdentity,
            bytes,
            entryRelativePath: 'entry.js',
            files: [{ relativePath: 'entry.js', digest: artifactDigest, byteSize: bytes.byteLength, bytes }],
        });

        await expect(first.removeAccount(persistentIdentity.accountScope))
            .rejects.toThrow('plugin_ui_artifact_account_cache_delete_failed');

        const restarted = createReactNativePersistentArtifactStore({ fileSystem: fake.fileSystem });
        await expect(restarted.read(persistentIdentity)).resolves.toBeNull();
        expect([...fake.files.keys()].some((path) => path.endsWith('/record.v1.json'))).toBe(false);
        expect(fake.files.size).toBeGreaterThan(0);
    });

    it('removes an incomplete record directory instead of retaining unreadable cache files', async () => {
        const fake = createFakeExpoFileSystemWithDirectoryDeletion();
        const entryBytes = new TextEncoder().encode('// persistent entry');
        const chunkBytes = new TextEncoder().encode('// persistent chunk');
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            releaseVersion: '1.2.3',
            pluginId: 'acme.plugin',
            contributionId: 'native',
            tier: 'reactNative' as const,
            platform: 'ios',
            artifactDigest: computePluginUiArtifactSha256DigestV1(entryBytes),
        };
        const store = createReactNativePersistentArtifactStore({ fileSystem: fake.fileSystem });
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
        const chunkPath = [...fake.files.keys()].find((path) => path.endsWith('.bin') && !path.endsWith('record.v1.json'));
        if (!chunkPath) throw new Error('Fixture must contain a persisted file.');
        fake.files.delete(chunkPath);

        await expect(store.read(persistentIdentity)).resolves.toBeNull();
        expect(fake.directoryDeletes).toHaveLength(1);
        expect(fake.files).toEqual(new Map());
    });

    it('treats a non-canonical manifest file digest as an incomplete record', async () => {
        const fake = createFakeExpoFileSystemWithDirectoryDeletion();
        const bytes = new TextEncoder().encode('// persistent entry');
        const artifactDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            releaseVersion: '1.2.3',
            pluginId: 'acme.plugin',
            contributionId: 'native',
            tier: 'reactNative' as const,
            platform: 'ios',
            artifactDigest,
        };
        const store = createReactNativePersistentArtifactStore({ fileSystem: fake.fileSystem });
        await store.write({
            persistentIdentity,
            bytes,
            entryRelativePath: 'entry.js',
            files: [{ relativePath: 'entry.js', digest: artifactDigest, byteSize: bytes.byteLength, bytes }],
        });

        const manifestPath = [...fake.files.keys()].find((path) => path.endsWith('/record.v1.json'));
        if (!manifestPath) throw new Error('Fixture must contain the persistent manifest.');
        const manifestBytes = fake.files.get(manifestPath);
        if (!manifestBytes) throw new Error('Fixture must contain the persistent manifest bytes.');
        const writtenManifest = new TextDecoder().decode(manifestBytes);
        const malformedManifest = writtenManifest.replace(
            `"digest":"${artifactDigest}"`,
            '"digest":"sha256:not-a-digest"',
        );
        expect(malformedManifest).not.toBe(writtenManifest);
        fake.files.set(manifestPath, new TextEncoder().encode(malformedManifest));

        await expect(store.read(persistentIdentity)).resolves.toBeNull();
        expect(fake.directoryDeletes).toHaveLength(1);
        expect(fake.files).toEqual(new Map());
    });

    it('describes a committed hosted Artifact through opaque native storage coordinates only', async () => {
        const fake = createFakeExpoFileSystem();
        const entryPath = 'hosted-web/acme/index.html';
        const scriptPath = 'hosted-web/acme/assets/app.js';
        const entryBytes = new TextEncoder().encode('<!doctype html><script src="assets/app.js"></script>');
        const scriptBytes = new TextEncoder().encode('export const mounted = true;');
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            releaseVersion: '1.2.3',
            pluginId: 'acme.plugin',
            contributionId: 'hosted',
            tier: 'hostedWeb' as const,
            platform: 'android',
            artifactDigest: computePluginUiArtifactSha256DigestV1(entryBytes),
        };
        const files = [
            {
                relativePath: entryPath,
                digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                byteSize: entryBytes.byteLength,
                bytes: entryBytes,
            },
            {
                relativePath: scriptPath,
                digest: computePluginUiArtifactSha256DigestV1(scriptBytes),
                byteSize: scriptBytes.byteLength,
                bytes: scriptBytes,
            },
        ] as const;
        const store = createReactNativePersistentArtifactStore({ fileSystem: fake.fileSystem });

        await store.write({
            persistentIdentity,
            bytes: entryBytes,
            entryRelativePath: entryPath,
            files,
        });

        const described = await store.describeNativeResource({
            identity: persistentIdentity,
            files: files.map(({ relativePath, digest, byteSize }) => ({ relativePath, digest, byteSize })),
        });

        expect(described).toEqual({
            locator: {
                namespace: 'happier-plugin-ui-artifacts-v1',
                accountKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
                artifactKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
            resources: [
                {
                    storedFileName: expect.stringMatching(/^[a-f0-9]{64}\.bin$/u),
                    digest: files[0].digest,
                    byteSize: files[0].byteSize,
                },
                {
                    storedFileName: expect.stringMatching(/^[a-f0-9]{64}\.bin$/u),
                    digest: files[1].digest,
                    byteSize: files[1].byteSize,
                },
            ],
        });
        const nativeDescriptor = JSON.stringify(described);
        expect(nativeDescriptor).not.toContain(entryPath);
        expect(nativeDescriptor).not.toContain(scriptPath);
        expect(nativeDescriptor).not.toContain(persistentIdentity.accountScope.serverId);
        expect(nativeDescriptor).not.toContain(persistentIdentity.accountScope.accountId);
        expect(nativeDescriptor).not.toContain(persistentIdentity.pluginId);

        await expect(store.describeNativeResource({
            identity: persistentIdentity,
            files: [{ ...files[0], digest: computePluginUiArtifactSha256DigestV1(new Uint8Array([0])) }],
        })).resolves.toBeNull();
    });

    it('removes only the selected Account directory', async () => {
        const fake = createFakeExpoFileSystemWithDirectoryDeletion();
        const bytes = new Uint8Array([4, 5, 6]);
        const artifactDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const base = {
            releaseVersion: '1.2.3',
            pluginId: 'acme.plugin',
            contributionId: 'native',
            tier: 'reactNative' as const,
            platform: 'ios',
            artifactDigest,
        };
        const accountA = { ...base, accountScope: { serverId: 'server-a', accountId: 'account-a' } };
        const accountB = { ...base, accountScope: { serverId: 'server-a', accountId: 'account-b' } };
        const store = createReactNativePersistentArtifactStore({ fileSystem: fake.fileSystem });
        const graph = (persistentIdentity: typeof accountA) => ({
            persistentIdentity,
            bytes,
            entryRelativePath: 'entry.js',
            files: [{ relativePath: 'entry.js', digest: artifactDigest, byteSize: bytes.byteLength, bytes }],
        });
        await store.write(graph(accountA));
        await store.write(graph(accountB));

        await store.removeAccount(accountA.accountScope);

        await expect(store.read(accountA)).resolves.toBeNull();
        await expect(store.read(accountB)).resolves.toMatchObject({ bytes });
    });
});

describe('React Native installed artifact disk GC', () => {
    it('keeps the current stable materialized directory across a compatibility generation replacement', async () => {
        const bytes = new Uint8Array([47, 47, 32, 105, 110, 115, 116, 97, 108, 108, 101, 100]);
        const artifactDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const retiringIdentity = buildIdentity({ artifactDigest });
        const currentIdentity = buildIdentity({
            artifactDigest,
            hostAppVersion: '9.0.0',
            hostUiApiVersion: '4.0.0',
            nativeCapabilitiesDigest: computePluginUiArtifactSha256DigestV1(new Uint8Array([15])),
            projectionGeneration: 13,
        });
        const fake = createFakeExpoFileSystemWithDirectoryDeletion();
        const materialize = createReactNativeInstalledArtifactFileMaterializer({ fileSystem: fake.fileSystem });
        const cache = createPluginReactNativeBundleCache({
            diskGc: createReactNativeInstalledArtifactDiskGc({ fileSystem: fake.fileSystem }),
        });

        const retiringUrl = await materialize({
            identity: retiringIdentity,
            bytes,
            scriptId: 'script:retiring',
        });
        const currentUrl = await materialize({
            identity: currentIdentity,
            bytes,
            scriptId: 'script:current',
        });
        const stableDirectoryName = resolveMaterializedArtifactDirectoryName(currentIdentity);
        expect(resolveMaterializedArtifactDirectoryName(retiringIdentity)).toBe(stableDirectoryName);
        expect(retiringUrl).toContain(`/${stableDirectoryName}/`);
        expect(currentUrl).toContain(`/${stableDirectoryName}/`);

        cache.putInstalledArtifact({ identity: retiringIdentity, bytes, format: 'plainJs' });
        cache.putInstalledArtifact({ identity: currentIdentity, bytes, format: 'plainJs' });
        cache.reconcileActiveProjectionIdentities([currentIdentity]);
        await Promise.resolve();

        expect(fake.files.has(currentUrl)).toBe(true);
        expect(fake.directoryDeletes).toEqual([]);
    });

    it('deletes the materialized on-disk bundle directory for an evicted identity', async () => {
        const bytes = new Uint8Array([47, 47, 32, 105, 110, 115, 116, 97, 108, 108, 101, 100]);
        const identity = buildIdentity({ artifactDigest: computePluginUiArtifactSha256DigestV1(bytes) });
        const fake = createFakeExpoFileSystemWithDirectoryDeletion();
        const materialize = createReactNativeInstalledArtifactFileMaterializer({ fileSystem: fake.fileSystem });
        const diskGc = createReactNativeInstalledArtifactDiskGc({ fileSystem: fake.fileSystem });

        const url = await materialize({ identity, bytes, scriptId: 'script:gc' });
        expect(fake.files.has(url)).toBe(true);

        await diskGc.evictForIdentities([identity]);

        expect(fake.files.has(url)).toBe(false);
        expect(fake.directoryDeletes).toHaveLength(1);
    });

    it('leaves other identities materialized when only one is evicted', async () => {
        const bytesA = new Uint8Array([1, 2, 3, 4]);
        const bytesB = new Uint8Array([5, 6, 7, 8]);
        const identityA = buildIdentity({ pluginId: 'acme.a', artifactDigest: computePluginUiArtifactSha256DigestV1(bytesA) });
        const identityB = buildIdentity({ pluginId: 'acme.b', artifactDigest: computePluginUiArtifactSha256DigestV1(bytesB) });
        const fake = createFakeExpoFileSystemWithDirectoryDeletion();
        const materialize = createReactNativeInstalledArtifactFileMaterializer({ fileSystem: fake.fileSystem });
        const diskGc = createReactNativeInstalledArtifactDiskGc({ fileSystem: fake.fileSystem });

        const urlA = await materialize({ identity: identityA, bytes: bytesA, scriptId: 'script:a' });
        const urlB = await materialize({ identity: identityB, bytes: bytesB, scriptId: 'script:b' });

        await diskGc.evictForIdentities([identityA]);

        expect(fake.files.has(urlA)).toBe(false);
        expect(fake.files.has(urlB)).toBe(true);
    });

    it('is a no-op when there is no native file system', async () => {
        const diskGc = createReactNativeInstalledArtifactDiskGc({
            fileSystem: { Paths: { cache: null }, Directory: class {} as never, File: class {} as never },
        });

        await expect(diskGc.evictForIdentities([buildIdentity()])).resolves.toBeUndefined();
    });
});
