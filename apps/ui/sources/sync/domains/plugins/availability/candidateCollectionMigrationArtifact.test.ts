import { describe, expect, it, vi } from 'vitest';

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    derivePluginUiNativeCapabilitiesDigestV1,
} from '@happier-dev/protocol/plugins/ui';
import { PluginReleaseFactsV1Schema } from '@happier-dev/protocol/plugins/availability';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';
import type { PluginArtifactSourceCandidate } from './artifactLease';
import {
    createPluginReactNativeArtifactLeaseCacheSink,
    createPluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import type { ActivePluginAccountHostedArtifactReader } from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead';

import {
    createCandidatePluginCollectionMigrationArtifactLoader,
    resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget,
} from './candidateCollectionMigrationArtifact';

const pluginId = 'example.tasks';
const releaseVersion = '2.0.0';
const entryPath = 'react-native/ios.bundle.js';
const entryBytes = new TextEncoder().encode('// candidate migration bundle');
const entryDigest = computePluginUiArtifactSha256DigestV1(entryBytes);
const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
    { relativePath: entryPath, bytes: entryBytes },
]);

const accountLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

const cacheIdentity: PluginReactNativeBundleCacheIdentity = Object.freeze({
    pluginId,
    contributionId: 'tasks-ui',
    artifactDigest,
    hostAppVersion: '1.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    platform: 'ios',
    channel: 'internal',
    nativeCapabilitiesDigest: `sha256:${'a'.repeat(64)}`,
    projectionGeneration: 1,
});

const graph = Object.freeze({
    contributionId: 'tasks-ui',
    tier: 'reactNative' as const,
    platform: 'ios' as const,
    entry: entryPath,
    files: [{ relativePath: entryPath, digest: entryDigest, byteSize: entryBytes.byteLength }],
    digest: artifactDigest,
    builtWith: { bundler: 'repack' as const, version: '5.0.0' },
    repack: { containerName: 'example_tasks', modulePath: './renderSurface', exportName: 'renderSurface' },
    collectionMigrations: {
        containerName: 'example_tasks',
        modulePath: './renderSurface',
        exportName: 'collectionMigrations',
    },
    hostUiApiVersion: cacheIdentity.hostUiApiVersion,
    compat: { react: cacheIdentity.reactVersion, reactNative: cacheIdentity.reactNativeVersion },
});

const manifest = Object.freeze({
    schemaVersion: 2,
    id: pluginId,
    version: releaseVersion,
    displayName: 'Example tasks',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: 'tasks',
            schemaVersion: 2,
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string', maxLength: 256 },
                    migrated: { type: 'boolean' },
                },
                required: ['id', 'migrated'],
                additionalProperties: false,
            },
            rowIdField: 'id',
            serverReadable: ['id', 'migrated'],
            indexes: [],
            uiQueries: [],
            relations: [],
            readableSchemaVersions: [1],
            migrations: [{
                id: 'upgrade-v1-to-v2',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
            }],
        }],
    },
});

const targetFacts = PluginReleaseFactsV1Schema.parse({
    ref: { pluginId, version: releaseVersion },
    archiveDigestSha256: `sha256:${'e'.repeat(64)}`,
    normalizedManifest: manifest,
    collectionContracts: [],
    uiSlots: [{
        contributionId: graph.contributionId,
        tier: graph.tier,
        platform: graph.platform,
        artifactDigest: graph.digest,
        compatibility: {
            hostUiApiVersion: graph.hostUiApiVersion,
            reactVersion: graph.compat.react,
            reactNativeVersion: graph.compat.reactNative,
        },
    }],
    packageAssetArchive: {
        archiveDigestSha256: `sha256:${'f'.repeat(64)}`,
        resources: [],
    },
});

function createAppExact(): PluginArtifactSourceCandidate & Readonly<{ kind: 'appExact' }> {
    return Object.freeze({
        kind: 'appExact' as const,
        readFile: async ({ relativePath }) => relativePath === entryPath
            ? new Uint8Array(entryBytes)
            : null,
    });
}

describe('candidate Collection migration Artifact loader', () => {
    it('derives one exact prospective Account-hosted target input without a daemon projection', async () => {
        const reader = {
            readTarget: vi.fn(async () => Object.freeze({
                kind: 'available' as const,
                value: Object.freeze({
                    link: Object.freeze({
                        release: targetFacts.ref,
                        contributionId: graph.contributionId,
                        tier: graph.tier,
                        platform: graph.platform,
                        artifactId: '00000000-0000-4000-8000-000000000001',
                        artifactDigest: graph.digest,
                        compatibility: Object.freeze({
                            hostAppVersion: '1.0.0',
                            hostUiApiVersion: graph.hostUiApiVersion,
                            reactVersion: graph.compat.react,
                            reactNativeVersion: graph.compat.reactNative,
                            platform: graph.platform,
                            channel: 'internal' as const,
                            nativeCapabilities: ['clipboard'],
                        }),
                    }),
                    archive: Object.freeze({ artifactGraph: graph }),
                }),
            })),
        } as unknown as ActivePluginAccountHostedArtifactReader;

        const result = await resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget({
            accountLifetime,
            isCurrent: () => true,
            availabilityCursor: 8,
            facts: targetFacts,
            reader,
        });

        expect(result).toMatchObject({
            kind: 'available',
            candidateTarget: {
                release: targetFacts.ref,
                artifact: {
                    contributionId: graph.contributionId,
                    platform: graph.platform,
                    digest: graph.digest,
                },
                availabilityCursor: 8,
            },
            artifact: {
                artifactGraph: graph,
                cacheIdentity: {
                    pluginId,
                    contributionId: graph.contributionId,
                    artifactDigest: graph.digest,
                    nativeCapabilitiesDigest: derivePluginUiNativeCapabilitiesDigestV1(['clipboard']),
                    projectionGeneration: 8,
                },
                accountHosted: { kind: 'target' },
            },
        });
        expect((reader.readTarget as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
            accountLifetime,
            release: targetFacts.ref,
            slot: {
                contributionId: graph.contributionId,
                tier: graph.tier,
                platform: graph.platform,
            },
            expectedArtifactDigest: graph.digest,
        });
    });

    it('rejects an Account-hosted target whose release slot compatibility differs from its otherwise matching link', async () => {
        const incompatibleGraph = Object.freeze({
            ...graph,
            hostUiApiVersion: '2.0.0',
        });
        const reader = {
            readTarget: vi.fn(async () => Object.freeze({
                kind: 'available' as const,
                value: Object.freeze({
                    link: Object.freeze({
                        release: targetFacts.ref,
                        contributionId: incompatibleGraph.contributionId,
                        tier: incompatibleGraph.tier,
                        platform: incompatibleGraph.platform,
                        artifactId: '00000000-0000-4000-8000-000000000001',
                        artifactDigest: incompatibleGraph.digest,
                        compatibility: Object.freeze({
                            hostAppVersion: '1.0.0',
                            hostUiApiVersion: incompatibleGraph.hostUiApiVersion,
                            reactVersion: incompatibleGraph.compat.react,
                            reactNativeVersion: incompatibleGraph.compat.reactNative,
                            platform: incompatibleGraph.platform,
                            channel: 'internal' as const,
                            nativeCapabilities: ['clipboard'],
                        }),
                    }),
                    archive: Object.freeze({ artifactGraph: incompatibleGraph }),
                }),
            })),
        } as unknown as ActivePluginAccountHostedArtifactReader;

        await expect(resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget({
            accountLifetime,
            isCurrent: () => true,
            availabilityCursor: 8,
            facts: targetFacts,
            reader,
        })).resolves.toEqual({ kind: 'unavailable' });
    });

    it('loads the signed migration export from exact target bytes without activating the plugin', async () => {
        const cache = createPluginReactNativeBundleCache();
        const activate = vi.fn();
        const migration = vi.fn((row: Readonly<Record<string, unknown>>) => ({ ...row, migrated: true }));
        const loadInstalledBundle = vi.fn(async () => (() => ({
            manifest,
            collectionMigrations: {
                tasks: [{
                    id: 'upgrade-v1-to-v2',
                    fromSchemaVersion: 1,
                    toSchemaVersion: 2,
                    migrate: migration,
                }],
            },
            activate,
        })));
        const loader = createCandidatePluginCollectionMigrationArtifactLoader({
            getCache: () => cache,
            createCacheSink: (lifetime) => createPluginReactNativeArtifactLeaseCacheSink({ cache, lifetime }),
            loaderBackend: {
                backendId: 'repackScriptManager',
                available: true,
                loadInstalledBundle,
            },
            hostPlatform: 'ios',
        });

        const result = await loader.load({
            accountLifetime,
            isCurrent: () => true,
            target: {
                release: { pluginId, version: releaseVersion },
                artifact: {
                    contributionId: graph.contributionId,
                    platform: graph.platform,
                    digest: graph.digest,
                },
                availabilityCursor: 8,
            },
            artifactGraph: graph,
            cacheIdentity,
            appExact: createAppExact(),
        });

        expect(result).toMatchObject({
            kind: 'available',
            candidate: {
                release: { ref: { pluginId, version: releaseVersion } },
                collectionContracts: [expect.objectContaining({ collectionId: 'tasks', schemaVersion: 2 })],
            },
        });
        expect(loadInstalledBundle).toHaveBeenCalledWith(expect.objectContaining({
            moduleReference: graph.collectionMigrations,
        }));
        expect(activate).not.toHaveBeenCalled();
        if (result.kind !== 'available') throw new Error('Expected the target candidate Artifact to load.');
        expect(result.candidate.collectionMigrations.tasks?.[0]?.migrate({ id: 'task-1' })).toEqual({
            id: 'task-1',
            migrated: true,
        });
        result.candidate.dispose();
    });

    it('forwards the private collection-migrations owner through the exact daemon byte request', async () => {
        const cache = createPluginReactNativeBundleCache();
        const origin: PluginMachineExecutionOriginV1 = Object.freeze({
            serverIdentityId: 'server-identity-a',
            materializationRef: Object.freeze({
                machineId: 'machine-a',
                materializationId: 'materialization-a',
                pluginId,
            }),
        });
        const fetchArtifactBytes = vi.fn(async () => Object.freeze({
            ok: true as const,
            artifactFamily: 'reactNative' as const,
            artifactOwnerKind: 'collectionMigrations' as const,
            cacheIdentity,
            artifact: {
                pluginId,
                contributionId: graph.contributionId,
                artifactKind: 'reactNativeBundle' as const,
                digest: graph.digest,
                format: 'plainJs' as const,
                byteSize: entryBytes.byteLength,
            },
            bytesBase64: encodeBase64(entryBytes),
            files: [{
                relativePath: entryPath,
                digest: entryDigest,
                byteSize: entryBytes.byteLength,
                bytesBase64: encodeBase64(entryBytes),
            }],
        }));
        const loader = createCandidatePluginCollectionMigrationArtifactLoader({
            getCache: () => cache,
            createCacheSink: (lifetime) => createPluginReactNativeArtifactLeaseCacheSink({ cache, lifetime }),
            loaderBackend: {
                backendId: 'repackScriptManager',
                available: true,
                loadInstalledBundle: async () => (() => ({
                    manifest,
                    collectionMigrations: {
                        tasks: [{
                            id: 'upgrade-v1-to-v2',
                            fromSchemaVersion: 1,
                            toSchemaVersion: 2,
                            migrate: (row: Readonly<Record<string, unknown>>) => ({ ...row, migrated: true }),
                        }],
                    },
                })),
            },
            hostPlatform: 'ios',
        });

        await expect(loader.load({
            accountLifetime,
            isCurrent: () => true,
            target: {
                release: { pluginId, version: releaseVersion },
                artifact: {
                    contributionId: graph.contributionId,
                    platform: graph.platform,
                    digest: graph.digest,
                },
                availabilityCursor: 8,
            },
            artifactGraph: graph,
            cacheIdentity,
            daemon: { origin, serverId: 'server-a', fetchArtifactBytes },
        })).resolves.toMatchObject({ kind: 'available' });
        expect(fetchArtifactBytes).toHaveBeenCalledWith({
            origin,
            serverId: 'server-a',
            identity: cacheIdentity,
            artifactOwnerKind: 'collectionMigrations',
        });
    });

    it('prepares an external target directly from its explicit prospective Account-hosted Artifact link', async () => {
        const cache = createPluginReactNativeBundleCache();
        const hostedReadFile = vi.fn(async ({ relativePath, accountHostedArtifactId }: Readonly<{
            relativePath: string;
            accountHostedArtifactId?: string;
        }>) => {
            expect(accountHostedArtifactId).toBe('candidate-artifact-id');
            return relativePath === entryPath ? new Uint8Array(entryBytes) : null;
        });
        const createAccountHostedSource = vi.fn(() => Object.freeze({
            kind: 'accountHosted' as const,
            readFile: hostedReadFile,
        }));
        const loader = createCandidatePluginCollectionMigrationArtifactLoader({
            getCache: () => cache,
            createCacheSink: (lifetime) => createPluginReactNativeArtifactLeaseCacheSink({ cache, lifetime }),
            createAccountHostedSource,
            loaderBackend: {
                backendId: 'repackScriptManager',
                available: true,
                loadInstalledBundle: async () => (() => ({
                    manifest,
                    collectionMigrations: {
                        tasks: [{
                            id: 'upgrade-v1-to-v2',
                            fromSchemaVersion: 1,
                            toSchemaVersion: 2,
                            migrate: (row: Readonly<Record<string, unknown>>) => ({ ...row, migrated: true }),
                        }],
                    },
                })),
            },
            hostPlatform: 'ios',
        });

        await expect(loader.load({
            accountLifetime,
            isCurrent: () => true,
            target: {
                release: { pluginId, version: releaseVersion },
                artifact: {
                    contributionId: graph.contributionId,
                    platform: graph.platform,
                    digest: graph.digest,
                },
                availabilityCursor: 8,
            },
            artifactGraph: graph,
            cacheIdentity,
            accountHosted: { kind: 'linked', artifactId: 'candidate-artifact-id' },
        })).resolves.toMatchObject({ kind: 'available' });
        expect(createAccountHostedSource).toHaveBeenCalledWith({ accountLifetime });
        expect(hostedReadFile).toHaveBeenCalledWith(expect.objectContaining({
            accountHostedArtifactId: 'candidate-artifact-id',
            artifact: expect.objectContaining({
                pluginId,
                releaseVersion,
                contributionId: graph.contributionId,
                digest: graph.digest,
            }),
        }));
    });

    it('prepares an external target through its exact Account release slot without borrowing an incumbent Artifact id', async () => {
        const cache = createPluginReactNativeBundleCache();
        // Account-hosted target cache entries are scoped by the exact
        // Availability cursor, never an unrelated daemon projection cursor.
        const targetCacheIdentity = Object.freeze({
            ...cacheIdentity,
            projectionGeneration: 8,
        });
        const targetReadFile = vi.fn(async ({ relativePath, accountHostedArtifactId }: Readonly<{
            relativePath: string;
            accountHostedArtifactId?: string;
        }>) => {
            expect(accountHostedArtifactId).toBeUndefined();
            return relativePath === entryPath ? new Uint8Array(entryBytes) : null;
        });
        const createAccountHostedTargetSource = vi.fn(() => Object.freeze({
            kind: 'accountHosted' as const,
            readFile: targetReadFile,
        }));
        const loader = createCandidatePluginCollectionMigrationArtifactLoader({
            getCache: () => cache,
            createCacheSink: (lifetime) => createPluginReactNativeArtifactLeaseCacheSink({ cache, lifetime }),
            createAccountHostedTargetSource,
            loaderBackend: {
                backendId: 'repackScriptManager',
                available: true,
                loadInstalledBundle: async () => (() => ({
                    manifest,
                    collectionMigrations: {
                        tasks: [{
                            id: 'upgrade-v1-to-v2',
                            fromSchemaVersion: 1,
                            toSchemaVersion: 2,
                            migrate: (row: Readonly<Record<string, unknown>>) => ({ ...row, migrated: true }),
                        }],
                    },
                })),
            },
            hostPlatform: 'ios',
        });

        await expect(loader.load({
            accountLifetime,
            isCurrent: () => true,
            target: {
                release: { pluginId, version: releaseVersion },
                artifact: {
                    contributionId: graph.contributionId,
                    platform: graph.platform,
                    digest: graph.digest,
                },
                availabilityCursor: 8,
            },
            artifactGraph: graph,
            cacheIdentity: targetCacheIdentity,
            accountHosted: { kind: 'target' },
        })).resolves.toMatchObject({ kind: 'available' });

        expect(createAccountHostedTargetSource).toHaveBeenCalledWith({ accountLifetime });
        const [targetReadInput] = targetReadFile.mock.calls[0]!;
        expect(targetReadInput).not.toHaveProperty('accountHostedArtifactId');
        expect(targetReadInput).toMatchObject({
            artifact: expect.objectContaining({
                pluginId,
                releaseVersion,
                contributionId: graph.contributionId,
                digest: graph.digest,
            }),
        });
    });

    it('does not load candidate code after exact target bytes return for a stale selection', async () => {
        const cache = createPluginReactNativeBundleCache();
        let current = true;
        let resolveRead!: (value: Uint8Array | null) => void;
        const delayedRead = new Promise<Uint8Array | null>((resolve) => { resolveRead = resolve; });
        const readFile = vi.fn(async () => await delayedRead);
        const loadInstalledBundle = vi.fn(async () => (() => ({ manifest, collectionMigrations: {} })));
        const loader = createCandidatePluginCollectionMigrationArtifactLoader({
            getCache: () => cache,
            createCacheSink: (lifetime) => createPluginReactNativeArtifactLeaseCacheSink({ cache, lifetime }),
            loaderBackend: {
                backendId: 'repackScriptManager',
                available: true,
                loadInstalledBundle,
            },
            hostPlatform: 'ios',
        });

        const pending = loader.load({
            accountLifetime,
            isCurrent: () => current,
            target: {
                release: { pluginId, version: releaseVersion },
                artifact: {
                    contributionId: graph.contributionId,
                    platform: graph.platform,
                    digest: graph.digest,
                },
                availabilityCursor: 8,
            },
            artifactGraph: graph,
            cacheIdentity,
            appExact: Object.freeze({ kind: 'appExact' as const, readFile }),
        });
        await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
        current = false;
        resolveRead(new Uint8Array(entryBytes));

        await expect(pending).resolves.toEqual({
            kind: 'unavailable',
            code: 'candidate_currentness_changed',
        });
        expect(loadInstalledBundle).not.toHaveBeenCalled();
    });
});
