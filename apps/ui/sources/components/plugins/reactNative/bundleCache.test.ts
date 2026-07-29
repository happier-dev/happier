import { describe, expect, it, vi } from 'vitest';

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { encodeBase64 } from '@/encryption/base64';

import {
    createPluginReactNativeBundleCache,
    derivePluginReactNativeBundleCacheKey,
    preloadReactNativeInstalledArtifactBytes,
    type PluginReactNativeBundleCacheIdentity,
} from './bundleCache';

const identity = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    expoRuntimeVersion: '0.2.0-native',
    hermesVersion: '0.15.0',
    platform: 'ios',
    channel: 'internal',
    nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    projectionGeneration: 12,
} as const;

describe('React Native bundle cache', () => {
    it('stores installed plain-JS artifact bytes by full runtime identity and evicts removed plugin bytes', () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        expect(cache.putInstalledArtifact({
            identity,
            bytes,
            format: 'plainJs',
        })).toEqual({ ok: true, cacheKey: derivePluginReactNativeBundleCacheKey(identity) });
        expect(cache.readInstalledArtifact(identity)?.bytes).toEqual(bytes);

        cache.evictForPluginDisable('acme.preview');
        expect(cache.readInstalledArtifact(identity)).toBeNull();

        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        cache.evictForPluginUninstall('acme.preview');
        expect(cache.readInstalledArtifact(identity)).toBeNull();
    });

    it('evicts cached executable bytes that belong to a replaced projection generation', () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);
        const currentIdentity = { ...identity, projectionGeneration: 13 };
        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        cache.putInstalledArtifact({ identity: currentIdentity, bytes, format: 'plainJs' });

        expect(cache.readInstalledArtifact(identity)).toBeNull();
        expect(cache.readInstalledArtifact(currentIdentity)).not.toBeNull();

        cache.evictForProjectionGenerationReplacement(13);

        expect(cache.readInstalledArtifact(identity)).toBeNull();
        expect(cache.readInstalledArtifact(currentIdentity)).not.toBeNull();

        cache.evictForProjectionGenerationReplacement(null);
        expect(cache.readInstalledArtifact(currentIdentity)).toBeNull();
    });

    it('deletes replaced same-contribution executable bytes from disk-level cache', async () => {
        const evictedIdentityBatches: PluginReactNativeBundleCacheIdentity[][] = [];
        const cache = createPluginReactNativeBundleCache({
            diskGc: {
                evictForIdentities: async (identities) => {
                    evictedIdentityBatches.push([...identities]);
                },
            },
        });
        const currentIdentity = { ...identity, projectionGeneration: 13 };
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        cache.putInstalledArtifact({ identity: currentIdentity, bytes, format: 'plainJs' });
        await Promise.resolve();

        expect(evictedIdentityBatches).toEqual([[identity]]);
        expect(cache.readInstalledArtifact(identity)).toBeNull();
        expect(cache.readInstalledArtifact(currentIdentity)).not.toBeNull();
    });

    it('drives disk-level GC for identities evicted on uninstall and disable', async () => {
        const evictedIdentityBatches: PluginReactNativeBundleCacheIdentity[][] = [];
        const cache = createPluginReactNativeBundleCache({
            diskGc: {
                evictForIdentities: async (identities) => {
                    evictedIdentityBatches.push([...identities]);
                },
            },
        });
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        cache.evictForPluginUninstall('acme.preview');
        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        cache.evictForPluginDisable('acme.preview');
        // A no-op eviction (nothing matches) must not invoke the disk GC.
        cache.evictForPluginDisable('missing.plugin');
        await Promise.resolve();

        expect(evictedIdentityBatches).toHaveLength(2);
        for (const batch of evictedIdentityBatches) {
            expect(batch).toEqual([identity]);
        }
    });

    it('returns cloned verified bytes so cache readers cannot mutate stored executable bytes', () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        expect(cache.putInstalledArtifact({
            identity,
            bytes,
            format: 'plainJs',
        })).toEqual({ ok: true, cacheKey: derivePluginReactNativeBundleCacheKey(identity) });

        const firstRead = cache.readInstalledArtifact(identity);
        expect(firstRead?.bytes).toEqual(bytes);
        firstRead!.bytes[0] = 0;

        const secondRead = cache.readInstalledArtifact(identity);
        expect(secondRead?.bytes).toEqual(bytes);
        expect(secondRead?.bytes).not.toBe(firstRead?.bytes);
    });

    it('rejects Hermes bytecode with a typed diagnostic', () => {
        const cache = createPluginReactNativeBundleCache();

        expect(cache.putInstalledArtifact({
            identity,
            bytes: new Uint8Array([0xc6, 0x1f, 0xbc, 0x03]),
            format: 'hermesBytecode',
        })).toEqual({
            ok: false,
            code: 'hermes_bytecode_unsupported',
            diagnostics: ['hermes_bytecode_unsupported'],
        });
    });

    it('preloads daemon-fetched artifact bytes only after digest verification', async () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);
        const digest = computePluginUiArtifactSha256DigestV1(bytes);
        const identityWithRealDigest = {
            ...identity,
            artifactDigest: digest,
        };
        const fetchArtifactBytes = vi.fn(async () => ({
            ok: true as const,
            cacheIdentity: identityWithRealDigest,
            artifact: {
                pluginId: 'acme.preview',
                contributionId: 'native-preview',
                artifactKind: 'reactNativeBundle' as const,
                digest,
                format: 'plainJs' as const,
                byteSize: bytes.byteLength,
            },
            bytesBase64: encodeBase64(bytes),
        }));

        await expect(preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: identityWithRealDigest,
            fetchArtifactBytes,
        })).resolves.toEqual({
            ok: true,
            cacheKey: derivePluginReactNativeBundleCacheKey(identityWithRealDigest),
        });
        expect(cache.readInstalledArtifact(identityWithRealDigest)?.bytes).toEqual(bytes);

        cache.evictForPluginUninstall('acme.preview');
        fetchArtifactBytes.mockResolvedValueOnce({
            ok: true,
            cacheIdentity: identityWithRealDigest,
            artifact: {
                pluginId: 'acme.preview',
                contributionId: 'native-preview',
                artifactKind: 'reactNativeBundle',
                digest,
                format: 'plainJs',
                byteSize: bytes.byteLength,
            },
            bytesBase64: encodeBase64(new Uint8Array([1, 2, 3])),
        });

        await expect(preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: identityWithRealDigest,
            fetchArtifactBytes,
        })).resolves.toEqual({
            ok: false,
            code: 'digest_mismatch',
            diagnostics: ['digest_mismatch'],
        });
        expect(cache.readInstalledArtifact(identityWithRealDigest)).toBeNull();
    });

    it('rejects an in-flight fetch after projection generation replacement and admits a neighboring fresh fetch', async () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new TextEncoder().encode('// generation-bound bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bytes);
        const fetchedIdentity = {
            ...identity,
            artifactDigest: digest,
        };
        const response = {
            ok: true as const,
            cacheIdentity: fetchedIdentity,
            artifact: {
                pluginId: fetchedIdentity.pluginId,
                contributionId: fetchedIdentity.contributionId,
                artifactKind: 'reactNativeBundle' as const,
                digest,
                format: 'plainJs' as const,
                byteSize: bytes.byteLength,
            },
            bytesBase64: encodeBase64(bytes),
        };
        let resolveFetch!: (value: typeof response) => void;
        const fetchPending = new Promise<typeof response>((resolve) => {
            resolveFetch = resolve;
        });

        const stalePreload = preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: fetchedIdentity,
            fetchArtifactBytes: async () => await fetchPending,
        });
        cache.evictForProjectionGenerationReplacement(fetchedIdentity.projectionGeneration + 1);
        resolveFetch(response);

        await expect(stalePreload).resolves.toEqual({
            ok: false,
            code: 'artifact_cache_write_invalidated',
            diagnostics: ['react_native_artifact_cache_write_invalidated'],
        });
        expect(cache.readInstalledArtifact(fetchedIdentity)).toBeNull();

        await expect(preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: fetchedIdentity,
            fetchArtifactBytes: async () => response,
        })).resolves.toEqual({
            ok: true,
            cacheKey: derivePluginReactNativeBundleCacheKey(fetchedIdentity),
        });
        expect(cache.readInstalledArtifact(fetchedIdentity)?.bytes).toEqual(bytes);
    });

    it('rejects an in-flight fetch when uninstall invalidates an otherwise empty plugin cache', async () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new TextEncoder().encode('// uninstalled bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bytes);
        const fetchedIdentity = {
            ...identity,
            artifactDigest: digest,
        };
        const response = {
            ok: true as const,
            cacheIdentity: fetchedIdentity,
            artifact: {
                pluginId: fetchedIdentity.pluginId,
                contributionId: fetchedIdentity.contributionId,
                artifactKind: 'reactNativeBundle' as const,
                digest,
                format: 'plainJs' as const,
                byteSize: bytes.byteLength,
            },
            bytesBase64: encodeBase64(bytes),
        };
        let resolveFetch!: (value: typeof response) => void;
        const fetchPending = new Promise<typeof response>((resolve) => {
            resolveFetch = resolve;
        });
        const neighboringBytes = new TextEncoder().encode('// neighboring current bundle');
        const neighboringDigest = computePluginUiArtifactSha256DigestV1(neighboringBytes);
        const neighboringIdentity = {
            ...fetchedIdentity,
            pluginId: 'neighbor.preview',
            artifactDigest: neighboringDigest,
        };
        const neighboringResponse = {
            ...response,
            cacheIdentity: neighboringIdentity,
            artifact: {
                ...response.artifact,
                pluginId: neighboringIdentity.pluginId,
                digest: neighboringDigest,
                byteSize: neighboringBytes.byteLength,
            },
            bytesBase64: encodeBase64(neighboringBytes),
        };
        let resolveNeighboringFetch!: (value: typeof neighboringResponse) => void;
        const neighboringFetchPending = new Promise<typeof neighboringResponse>((resolve) => {
            resolveNeighboringFetch = resolve;
        });

        const preload = preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: fetchedIdentity,
            fetchArtifactBytes: async () => await fetchPending,
        });
        const neighboringPreload = preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: neighboringIdentity,
            fetchArtifactBytes: async () => await neighboringFetchPending,
        });
        cache.evictForPluginUninstall(fetchedIdentity.pluginId);
        resolveFetch(response);
        resolveNeighboringFetch(neighboringResponse);

        await expect(preload).resolves.toEqual({
            ok: false,
            code: 'artifact_cache_write_invalidated',
            diagnostics: ['react_native_artifact_cache_write_invalidated'],
        });
        expect(cache.readInstalledArtifact(fetchedIdentity)).toBeNull();
        await expect(neighboringPreload).resolves.toEqual({
            ok: true,
            cacheKey: derivePluginReactNativeBundleCacheKey(neighboringIdentity),
        });
        expect(cache.readInstalledArtifact(neighboringIdentity)?.bytes).toEqual(neighboringBytes);
    });

    it('preloads sibling chunk files from the daemon byte response with per-file integrity', async () => {
        const cache = createPluginReactNativeBundleCache();
        const entryBytes = new Uint8Array([47, 47, 32, 101, 110, 116, 114, 121]);
        const chunkBytes = new Uint8Array([47, 47, 32, 99, 104, 117, 110, 107]);
        const entryDigest = computePluginUiArtifactSha256DigestV1(entryBytes);
        const chunkDigest = computePluginUiArtifactSha256DigestV1(chunkBytes);
        const identityWithRealDigest = {
            ...identity,
            artifactDigest: entryDigest,
        };

        await expect(preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: identityWithRealDigest,
            fetchArtifactBytes: vi.fn(async () => ({
                ok: true as const,
                cacheIdentity: identityWithRealDigest,
                artifact: {
                    pluginId: 'acme.preview',
                    contributionId: 'native-preview',
                    artifactKind: 'reactNativeBundle' as const,
                    digest: entryDigest,
                    format: 'plainJs' as const,
                    byteSize: entryBytes.byteLength,
                },
                bytesBase64: encodeBase64(entryBytes),
                files: [
                    {
                        relativePath: 'react-native/native-preview/ios.bundle.js',
                        digest: entryDigest,
                        byteSize: entryBytes.byteLength,
                        bytesBase64: encodeBase64(entryBytes),
                    },
                    {
                        relativePath: 'react-native/native-preview/src_ui_renderSurface_tsx.chunk.bundle',
                        digest: chunkDigest,
                        byteSize: chunkBytes.byteLength,
                        bytesBase64: encodeBase64(chunkBytes),
                    },
                ],
            })),
        })).resolves.toEqual({
            ok: true,
            cacheKey: derivePluginReactNativeBundleCacheKey(identityWithRealDigest),
        });

        expect(cache.readInstalledArtifact(identityWithRealDigest)?.files).toEqual([
            {
                relativePath: 'react-native/native-preview/ios.bundle.js',
                digest: entryDigest,
                byteSize: entryBytes.byteLength,
                bytes: entryBytes,
            },
            {
                relativePath: 'react-native/native-preview/src_ui_renderSurface_tsx.chunk.bundle',
                digest: chunkDigest,
                byteSize: chunkBytes.byteLength,
                bytes: chunkBytes,
            },
        ]);
    });

    it('verifies a generated native Re.Pack graph as a complete file set and rejects stale identity or tampered bytes', async () => {
        const cache = createPluginReactNativeBundleCache();
        const entryPath = 'react-native/native-preview/index.js';
        const chunkPath = 'react-native/native-preview/chunk.js';
        const entryBytes = new TextEncoder().encode('export { renderSurface } from "./chunk.js";');
        const chunkBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
        const graphDigest = computePluginUiArtifactFileSetSha256DigestV1([
            { relativePath: entryPath, bytes: entryBytes },
            { relativePath: chunkPath, bytes: chunkBytes },
        ]);
        const generatedIdentity: PluginReactNativeBundleCacheIdentity = {
            ...identity,
            artifactDigest: graphDigest,
        };
        const artifactGraph = {
            contributionId: 'native-preview-artifact',
            tier: 'reactNative' as const,
            platform: 'ios' as const,
            entry: entryPath,
            files: [
                {
                    relativePath: chunkPath,
                    digest: computePluginUiArtifactSha256DigestV1(chunkBytes),
                    byteSize: chunkBytes.byteLength,
                },
                {
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                },
            ],
            digest: graphDigest,
            builtWith: { bundler: 'repack' as const, version: '5.0.0' },
            repack: {
                containerName: 'acme_preview_native',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.0.0', reactNative: '0.83.4' },
        };
        const fetchArtifactBytes = vi.fn(async () => ({
            ok: true as const,
            cacheIdentity: generatedIdentity,
            artifact: {
                pluginId: generatedIdentity.pluginId,
                contributionId: generatedIdentity.contributionId,
                artifactKind: 'reactNativeBundle' as const,
                digest: graphDigest,
                format: 'plainJs' as const,
                byteSize: entryBytes.byteLength,
            },
            bytesBase64: encodeBase64(entryBytes),
            files: [
                {
                    relativePath: chunkPath,
                    digest: computePluginUiArtifactSha256DigestV1(chunkBytes),
                    byteSize: chunkBytes.byteLength,
                    bytesBase64: encodeBase64(chunkBytes),
                },
                {
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                    bytesBase64: encodeBase64(entryBytes),
                },
            ],
        }));

        await expect(preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: generatedIdentity,
            artifactGraph,
            fetchArtifactBytes,
        })).resolves.toEqual({
            ok: true,
            cacheKey: derivePluginReactNativeBundleCacheKey(generatedIdentity),
        });
        expect(cache.readInstalledArtifact(generatedIdentity)).toMatchObject({
            bytes: entryBytes,
            entryRelativePath: entryPath,
        });

        cache.evictForPluginDisable(generatedIdentity.pluginId);
        fetchArtifactBytes.mockResolvedValueOnce({
            ...(await fetchArtifactBytes()),
            cacheIdentity: {
                ...generatedIdentity,
                projectionGeneration: generatedIdentity.projectionGeneration + 1,
            },
        });
        await expect(preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: generatedIdentity,
            artifactGraph,
            fetchArtifactBytes,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_identity_mismatch',
            diagnostics: ['react_native_cache_identity_mismatch'],
        });

        fetchArtifactBytes.mockResolvedValueOnce(await fetchArtifactBytes());
        const { repack: _missingRepackIdentity, ...nativeGraphWithoutRepackIdentity } = artifactGraph;
        await expect(preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: generatedIdentity,
            artifactGraph: nativeGraphWithoutRepackIdentity,
            fetchArtifactBytes,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_identity_mismatch',
            diagnostics: ['react_native_artifact_graph_identity_mismatch'],
        });

        fetchArtifactBytes.mockResolvedValueOnce({
            ...(await fetchArtifactBytes()),
            files: [
                {
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                    bytesBase64: encodeBase64(entryBytes),
                },
            ],
        });
        await expect(preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: generatedIdentity,
            artifactGraph,
            fetchArtifactBytes,
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_response',
            diagnostics: ['react_native_artifact_graph_file_set_mismatch'],
        });

        const tamperedChunk = new TextEncoder().encode('export function renderSurface() { return "tampered"; }');
        fetchArtifactBytes.mockResolvedValueOnce({
            ...(await fetchArtifactBytes()),
            files: [
                {
                    relativePath: chunkPath,
                    digest: computePluginUiArtifactSha256DigestV1(tamperedChunk),
                    byteSize: tamperedChunk.byteLength,
                    bytesBase64: encodeBase64(tamperedChunk),
                },
                {
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                    bytesBase64: encodeBase64(entryBytes),
                },
            ],
        });
        await expect(preloadReactNativeInstalledArtifactBytes({
            cache,
            identity: generatedIdentity,
            artifactGraph,
            fetchArtifactBytes,
        })).resolves.toEqual({
            ok: false,
            code: 'digest_mismatch',
            diagnostics: ['react_native_artifact_file_manifest_mismatch'],
        });
    });
});
