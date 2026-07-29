import { describe, expect, it, vi } from 'vitest';

import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

import {
    createReactNativeInstalledArtifactDiskGc,
    createReactNativeInstalledArtifactFileMaterializer,
} from './artifactFileMaterializer';
import type { PluginReactNativeBundleCacheIdentity } from './bundleCache';

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

function createFakeExpoFileSystemWithDirectoryDeletion(cacheUri = 'file:///cache/') {
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

        delete(): void {
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

describe('React Native installed artifact disk GC', () => {
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
