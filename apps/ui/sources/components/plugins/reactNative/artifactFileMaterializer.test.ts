import { describe, expect, it, vi } from 'vitest';
import * as sha2 from '@noble/hashes/sha2';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
import { createReactNativePersistentArtifactStore } from './artifactFileMaterializer';

// Observe the cryptographic boundary while executing its real implementation.
vi.mock('@noble/hashes/sha2', async importOriginal => {
    const original = await importOriginal<typeof import('@noble/hashes/sha2')>();
    return { ...original, sha256: Object.assign(vi.fn(original.sha256), original.sha256) };
});

/** Expo filesystem is the boundary; native record and descriptor logic stay real. */
function createFileSystem() {
    const files = new Map<string, Uint8Array>();
    const reads: string[] = [];
    const uriFor = (parts: Array<string | { uri: string }>) => parts
        .map(part => typeof part === 'string' ? part : part.uri).join('/').replace(/([^:])\/+/gu, '$1/');
    class Directory {
        readonly uri: string;
        constructor(...parts: Array<string | { uri: string }>) { this.uri = uriFor(parts); }
        get exists() { return [...files.keys()].some(path => path.startsWith(`${this.uri}/`)); }
        create() {}
        list() {
            const children = new Set([...files.keys()].flatMap(path => {
                if (!path.startsWith(`${this.uri}/`)) return [];
                const relative = path.slice(this.uri.length + 1);
                return relative.includes('/') ? [relative.split('/')[0]!] : [];
            }));
            return [...children].map(child => new Directory(this, child));
        }
        delete() {
            for (const path of files.keys()) if (path.startsWith(`${this.uri}/`)) files.delete(path);
        }
    }
    class File {
        readonly uri: string;
        constructor(...parts: Array<string | { uri: string }>) { this.uri = uriFor(parts); }
        get exists() { return files.has(this.uri); }
        get size() { return files.get(this.uri)?.byteLength ?? 0; }
        async bytes() {
            reads.push(this.uri);
            const bytes = files.get(this.uri);
            if (!bytes) throw new Error('File unavailable');
            return new Uint8Array(bytes);
        }
        write(bytes: Uint8Array) { files.set(this.uri, new Uint8Array(bytes)); }
        delete() { files.delete(this.uri); }
    }
    return { fileSystem: { Directory, File, Paths: { cache: 'file:///cache' } }, files, reads };
}

describe('native persistent Artifact byte loading', () => {
    it('reads admitted bytes without hashing and describes their selected graph without reading content', async () => {
        const boundary = createFileSystem();
        const store = createReactNativePersistentArtifactStore({ fileSystem: boundary.fileSystem });
        const bytes = new TextEncoder().encode('// native persisted artifact');
        const entryRelativePath = 'entry.js';
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            artifactDigest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryRelativePath, bytes }]),
        };
        const files = [{ relativePath: entryRelativePath, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength, bytes }];
        await store.write({ persistentIdentity, entryRelativePath, bytes, files });
        const hashing = vi.mocked(sha2.sha256);
        hashing.mockClear();
        try {
            await expect(store.read(persistentIdentity)).resolves.toMatchObject({ bytes });
            await expect(store.read(persistentIdentity)).resolves.toMatchObject({ bytes });
            const contentHashes = hashing.mock.calls.filter(([input]) => input instanceof Uint8Array
                && input.byteLength === bytes.byteLength && input.every((value, index) => value === bytes[index]));
            expect(contentHashes).toHaveLength(0);
            boundary.reads.length = 0;
            await expect(store.describeNativeResource({ identity: persistentIdentity, files })).resolves.toMatchObject({
                resources: [{ digest: files[0]!.digest, byteSize: bytes.byteLength }],
            });
            expect(boundary.reads.filter(path => path.endsWith('.bin'))).toHaveLength(0);
            await expect(store.describeNativeResource({ identity: persistentIdentity,
                files: [{ ...files[0]!, digest: `sha256:${'f'.repeat(64)}` }],
            })).resolves.toBeNull();
        } finally { hashing.mockClear(); }
    });
});
