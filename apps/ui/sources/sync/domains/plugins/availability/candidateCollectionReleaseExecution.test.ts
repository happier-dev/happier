import { describe, expect, it, vi } from 'vitest';

import {
    PluginMachineMaterializationV1Schema} from '@happier-dev/protocol/plugins/availability/v1';
import {
    PluginProjectionV2Schema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginReleaseFactsV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginAccountAvailabilityReader } from './reader';

import {
    resolveCandidateCollectionReleaseExecution,
} from './candidateCollectionReleaseExecution';

vi.mock('./generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: Object.freeze([]),
}));

const pluginId = 'example.tasks';
const version = '2.0.0';
const archiveDigest = `sha256:${'a'.repeat(64)}`;
const artifactDigest = `sha256:${'b'.repeat(64)}`;
const fileDigest = `sha256:${'c'.repeat(64)}`;

const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({
    artifactId: 'tasks-collections',
    tier: 'reactNative',
    entry: 'react-native/tasks-collections/entry.cjs.bundle',
    files: [{ relativePath: 'react-native/tasks-collections/entry.cjs.bundle', digest: fileDigest, byteSize: 1 }],
    digest: artifactDigest,
    builtWith: { bundler: 'esbuild', version: '0.25.0' },
    executable: { exports: ['collectionMigrations', 'renderSurface'] },
    hostUiApiRange: '^1.0.0',
});

const facts = PluginReleaseFactsV1Schema.parse({
    ref: { pluginId, version },
    archiveDigestSha256: archiveDigest,
    normalizedManifest: {
        schemaVersion: 2,
        id: pluginId,
        version,
        displayName: 'Example tasks',
        engines: { happier: '^1.0.0' },
        runtime: { apiVersion: 1 },
        contributes: {
            accountCollections: [{
                id: 'tasks-collections',
                schemaVersion: 2,
                schema: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id'],
                    additionalProperties: true,
                },
                rowIdField: 'id',
                serverReadable: ['id'],
                indexes: [],
                uiQueries: [],
                relations: [],
                readableSchemaVersions: [1],
                migrations: [{ id: 'v1-v2', fromSchemaVersion: 1, toSchemaVersion: 2 }],
                migrationArtifact: {
                    artifactId: artifactGraph.artifactId,
                    exportName: 'collectionMigrations',
                },
            }],
        },
    },
    collectionContracts: [],
    uiSlots: [{
        contributionId: 'tasks-collections',
        artifactId: artifactGraph.artifactId,
        tier: artifactGraph.tier,
        platform: 'ios',
        artifactDigest: artifactGraph.digest,
        hostUiApiRange: artifactGraph.hostUiApiRange,
    }],
    packageAssetArchive: {
        archiveDigestSha256: archiveDigest,
        resources: [],
    },
});

const materialization = PluginMachineMaterializationV1Schema.parse({
    serverIdentityId: 'srv_a',
    machineId: 'machine-a',
    materializationId: 'materialization-a',
    pluginId,
    version,
    sourceClass: 'versionedArchive',
    portableRelease: true,
    archiveDigestSha256: archiveDigest,
    uiArtifacts: [{
        contributionId: 'tasks-collections',
        artifactId: artifactGraph.artifactId,
        tier: artifactGraph.tier,
        platform: 'ios',
        artifactDigest: artifactGraph.digest,
        hostUiApiRange: artifactGraph.hostUiApiRange,
    }],
    enabled: true,
    trustState: 'trusted',
    observedAt: 1,
});

const cacheIdentity = {
    pluginId,
    contributionId: 'tasks-collections',
    artifactId: artifactGraph.artifactId,
    artifactDigest: artifactGraph.digest,
    platform: 'ios',
} as const;
const projectedByteIdentity = { artifactDigest: artifactGraph.digest } as const;

function createProjection(entries: Readonly<Record<string, unknown>> = {}) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 4,
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'reactNativeBundle:example.tasks:tasks-collections': {
                        id: 'reactNativeBundle:example.tasks:tasks-collections',
                        pluginId,
                        pluginVersion: version,
                        contributionKind: 'reactNativeBundle',
                        contributionId: 'tasks-collections',
                        generatedV2: true,
                        generatedOwnerKind: 'collectionMigrations',
                        occurrenceId: 'example.tasks-occurrence-a',
                        artifactGraph,
                        runtime: { cacheIdentity: projectedByteIdentity },
                        executionOrigin: {
                            serverIdentityId: materialization.serverIdentityId,
                            materializationRef: {
                                machineId: materialization.machineId,
                                materializationId: materialization.materializationId,
                                pluginId: materialization.pluginId,
                            },
                        },
                    },
                    ...entries,
                },
            },
        },
    });
}

function createReader(currentMaterialization = materialization): PluginAccountAvailabilityReader {
    return {
        readMaterializations: () => ({
            kind: 'available',
            availabilityCursor: 11,
            materializations: [currentMaterialization],
            snapshots: [{
                serverIdentityId: currentMaterialization.serverIdentityId,
                machineId: currentMaterialization.machineId,
                materializations: [currentMaterialization],
            }],
        }),
    } as unknown as PluginAccountAvailabilityReader;
}

function createLifetime(current = () => true): ActiveServerAccountScopeLifetime {
    return {
        scope: { serverId: 'server-route-a', accountId: 'account-a' },
        isCurrent: current,
        onRetire: () => ({ dispose() {} }),
    };
}

function resolve(input: Readonly<{
    projection?: ReturnType<typeof createProjection> | null;
    reader?: PluginAccountAvailabilityReader | null;
    accountLifetime?: ActiveServerAccountScopeLifetime;
    isCurrent?: () => boolean;
}>) {
    return resolveCandidateCollectionReleaseExecution({
        target: { availabilityCursor: 11, facts },
        projection: input.projection === undefined ? createProjection() : input.projection,
        reader: input.reader === undefined ? createReader() : input.reader,
        accountLifetime: input.accountLifetime ?? createLifetime(),
        daemon: {
            serverId: 'server-route-a',
            serverIdentityId: materialization.serverIdentityId,
            machineId: materialization.machineId,
        },
        isCurrent: input.isCurrent ?? (() => true),
    });
}

describe('candidate Collection release execution resolver', () => {
    it('projects one exact trusted daemon candidate from the raw current projection', () => {
        expect(resolve({})).toEqual({
            kind: 'available',
            source: {
                kind: 'daemon',
                release: { availabilityCursor: 11, facts },
                origin: {
                    serverIdentityId: materialization.serverIdentityId,
                    materializationRef: {
                        machineId: materialization.machineId,
                        materializationId: materialization.materializationId,
                        pluginId,
                    },
                },
                serverId: 'server-route-a',
                artifactGraph,
                cacheIdentity,
            },
        });
    });

    it('fails closed when the selected materialization does not prove the target release archive', () => {
        const mismatchedArchive = PluginMachineMaterializationV1Schema.parse({
            ...materialization,
            archiveDigestSha256: `sha256:${'e'.repeat(64)}`,
        });

        expect(resolve({ reader: createReader(mismatchedArchive) })).toEqual({ kind: 'unavailable' });
    });

    it('does not choose between matching raw candidate entries or retain a stale action', () => {
        const duplicate = {
            id: 'reactNativeBundle:example.tasks:tasks-collections:duplicate',
            pluginId,
            pluginVersion: version,
            contributionKind: 'reactNativeBundle',
            contributionId: 'tasks-collections',
            generatedV2: true,
            generatedOwnerKind: 'collectionMigrations',
            occurrenceId: 'example.tasks-occurrence-b',
            artifactGraph,
            runtime: { cacheIdentity: projectedByteIdentity },
            executionOrigin: {
                serverIdentityId: materialization.serverIdentityId,
                materializationRef: {
                    machineId: materialization.machineId,
                    materializationId: materialization.materializationId,
                    pluginId,
                },
            },
        };

        expect(resolve({ projection: createProjection({ duplicate }) })).toEqual({ kind: 'unavailable' });
        expect(resolve({ isCurrent: () => false })).toEqual({ kind: 'unavailable' });
    });
});
