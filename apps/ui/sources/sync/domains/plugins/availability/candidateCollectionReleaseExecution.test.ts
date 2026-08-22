import { describe, expect, it } from 'vitest';

import {
    PluginMachineMaterializationV1Schema,
    PluginProjectionV2Schema,
} from '@happier-dev/protocol';
import { PluginReleaseFactsV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginUiArtifactsManifestEntryV1Schema } from '@happier-dev/protocol/plugins/ui';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginAccountAvailabilityReader } from './reader';

import {
    resolveCandidateCollectionReleaseExecution,
} from './candidateCollectionReleaseExecution';

const pluginId = 'example.tasks';
const version = '2.0.0';
const archiveDigest = `sha256:${'a'.repeat(64)}`;
const artifactDigest = `sha256:${'b'.repeat(64)}`;
const fileDigest = `sha256:${'c'.repeat(64)}`;
const nativeCapabilitiesDigest = `sha256:${'d'.repeat(64)}`;

const artifactGraph = PluginUiArtifactsManifestEntryV1Schema.parse({
    contributionId: 'tasks-collections',
    tier: 'reactNative',
    platform: 'ios',
    entry: 'entry.mjs.bundle',
    files: [{ relativePath: 'entry.mjs.bundle', digest: fileDigest, byteSize: 1 }],
    digest: artifactDigest,
    builtWith: { bundler: 'repack', version: '1.0.0' },
    repack: {
        containerName: 'tasks_collections',
        modulePath: './entry',
        exportName: 'renderSurface',
    },
    collectionMigrations: {
        containerName: 'tasks_collections',
        modulePath: './entry',
        exportName: 'collectionMigrations',
    },
    hostUiApiVersion: '1.0.0',
    compat: { react: '19.0.0', reactNative: '0.83.4' },
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
        contributes: {},
    },
    collectionContracts: [],
    uiSlots: [{
        contributionId: artifactGraph.contributionId,
        tier: artifactGraph.tier,
        platform: artifactGraph.platform,
        artifactDigest: artifactGraph.digest,
        compatibility: {
            hostUiApiVersion: artifactGraph.hostUiApiVersion,
            reactVersion: artifactGraph.compat.react,
            reactNativeVersion: artifactGraph.compat.reactNative,
        },
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
        contributionId: artifactGraph.contributionId,
        tier: artifactGraph.tier,
        platform: artifactGraph.platform,
        artifactDigest: artifactGraph.digest,
    }],
    enabled: true,
    trustState: 'trusted',
    observedAt: 1,
});

const cacheIdentity = {
    pluginId,
    contributionId: artifactGraph.contributionId,
    artifactDigest: artifactGraph.digest,
    hostAppVersion: '1.0.0',
    hostUiApiVersion: artifactGraph.hostUiApiVersion,
    reactVersion: artifactGraph.compat.react,
    reactNativeVersion: artifactGraph.compat.reactNative,
    platform: artifactGraph.platform,
    channel: 'internal',
    nativeCapabilitiesDigest,
    projectionGeneration: 4,
} as const;

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
                        contributionId: artifactGraph.contributionId,
                        generatedV2: true,
                        generatedOwnerKind: 'collectionMigrations',
                        artifactGraph,
                        runtime: { cacheIdentity },
                        serverIdentityId: materialization.serverIdentityId,
                        materializationRef: {
                            machineId: materialization.machineId,
                            materializationId: materialization.materializationId,
                            pluginId: materialization.pluginId,
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
            contributionId: artifactGraph.contributionId,
            generatedV2: true,
            generatedOwnerKind: 'collectionMigrations',
            artifactGraph,
            runtime: { cacheIdentity },
            serverIdentityId: materialization.serverIdentityId,
            materializationRef: {
                machineId: materialization.machineId,
                materializationId: materialization.materializationId,
                pluginId,
            },
        };

        expect(resolve({ projection: createProjection({ duplicate }) })).toEqual({ kind: 'unavailable' });
        expect(resolve({ isCurrent: () => false })).toEqual({ kind: 'unavailable' });
    });
});
