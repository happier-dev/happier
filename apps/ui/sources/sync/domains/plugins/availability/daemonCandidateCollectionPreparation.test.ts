import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    normalizePluginAccountCollectionContractsV1,
    PluginPortableReleaseManifestV1Schema,
} from '@happier-dev/protocol';
import { PluginReleaseFactsV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginUiArtifactsManifestEntryV1Schema } from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const callGuardedMachineRpcWithPolicyMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: callGuardedMachineRpcWithPolicyMock,
}));

import {
    createDaemonCandidateCollectionReleasePreparation,
} from './daemonCandidateCollectionPreparation';

const pluginId = 'example.tasks';
const sourceVersion = '1.0.0';
const targetVersion = '2.0.0';
const hostUiApiVersion = '1.0.0';
const reactVersion = '19.2.0';
const reactNativeVersion = '0.83.4';
const platform = 'ios' as const;
const sourceManifest = PluginPortableReleaseManifestV1Schema.parse({
    schemaVersion: 2,
    id: pluginId,
    version: sourceVersion,
    displayName: 'Source tasks',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: 'tasks',
            schemaVersion: 1,
            schema: {
                type: 'object',
                properties: { id: { type: 'string', maxLength: 256 } },
                required: ['id'],
                additionalProperties: false,
            },
            rowIdField: 'id',
            serverReadable: ['id'],
            indexes: [],
            uiQueries: [],
            relations: [],
            readableSchemaVersions: [],
            migrations: [],
        }],
    },
});
const targetManifest = PluginPortableReleaseManifestV1Schema.parse({
    schemaVersion: 2,
    id: pluginId,
    version: targetVersion,
    displayName: 'Target tasks',
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
                    status: { type: 'string', maxLength: 256 },
                },
                required: ['id', 'status'],
                additionalProperties: false,
            },
            rowIdField: 'id',
            serverReadable: ['id', 'status'],
            indexes: [],
            uiQueries: [],
            relations: [],
            readableSchemaVersions: [1],
            migrations: [{
                id: 'tasks-v1-to-v2',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
            }],
        }],
    },
});
const sourceContracts = normalizePluginAccountCollectionContractsV1({
    pluginId,
    contributions: sourceManifest.contributes.accountCollections,
});
const targetContracts = normalizePluginAccountCollectionContractsV1({
    pluginId,
    contributions: targetManifest.contributes.accountCollections,
});
const targetRefs = targetContracts.map((contract) => ({
    pluginId: contract.pluginId,
    collectionId: contract.collectionId,
    schemaVersion: contract.schemaVersion,
    contractDigest: contract.contractDigest,
}));
const artifactGraph = PluginUiArtifactsManifestEntryV1Schema.parse({
    contributionId: 'tasks-migrations',
    tier: 'reactNative',
    platform,
    entry: 'react-native/tasks/ios.bundle.js',
    files: [{
        relativePath: 'react-native/tasks/ios.bundle.js',
        digest: `sha256:${'a'.repeat(64)}`,
        byteSize: 1,
    }],
    digest: `sha256:${'b'.repeat(64)}`,
    builtWith: { bundler: 'repack', version: '5.2.5' },
    repack: {
        containerName: 'tasks_migrations',
        modulePath: './renderSurface',
        exportName: 'renderSurface',
    },
    collectionMigrations: {
        containerName: 'tasks_migrations',
        modulePath: './renderSurface',
        exportName: 'collectionMigrations',
    },
    hostUiApiVersion,
    compat: { react: reactVersion, reactNative: reactNativeVersion },
});
const facts = PluginReleaseFactsV1Schema.parse({
    ref: { pluginId, version: targetVersion },
    archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
    normalizedManifest: targetManifest,
    collectionContracts: targetRefs,
    uiSlots: [{
        contributionId: artifactGraph.contributionId,
        tier: artifactGraph.tier,
        platform,
        artifactDigest: artifactGraph.digest,
        compatibility: {
            hostUiApiVersion,
            reactVersion,
            reactNativeVersion,
        },
    }],
    packageAssetArchive: {
        archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
        resources: [],
    },
});
const execution = Object.freeze({
    kind: 'daemon' as const,
    release: Object.freeze({ availabilityCursor: 11, facts }),
    origin: Object.freeze({
        serverIdentityId: 'srv_candidate',
        materializationRef: Object.freeze({
            machineId: 'machine-candidate',
            materializationId: 'materialization-candidate',
            pluginId,
        }),
    }),
    serverId: 'server-route-candidate',
    artifactGraph,
    cacheIdentity: Object.freeze({
        pluginId,
        contributionId: artifactGraph.contributionId,
        artifactDigest: artifactGraph.digest,
        hostAppVersion: '1.0.0',
        hostUiApiVersion,
        reactVersion,
        reactNativeVersion,
        platform,
        channel: 'internal' as const,
        nativeCapabilitiesDigest: `sha256:${'d'.repeat(64)}`,
        projectionGeneration: 4,
    }),
});
const binding = Object.freeze({
    source: Object.freeze({
        pluginId: sourceContracts[0]!.pluginId,
        collectionId: sourceContracts[0]!.collectionId,
        schemaVersion: sourceContracts[0]!.schemaVersion,
        contractDigest: sourceContracts[0]!.contractDigest,
    }),
    target: Object.freeze({ ...targetRefs[0]! }),
    candidate: Object.freeze({
        releaseVersion: targetVersion,
        artifactDigest: artifactGraph.digest,
    }),
});

function lifetime(current: () => boolean = () => true) {
    return Object.freeze({
        scope: Object.freeze({ serverId: 'server-route-candidate', accountId: 'account-candidate' }),
        isCurrent: current,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
}

function input(overrides: Readonly<{
    targetContracts?: typeof targetRefs;
    isCurrent?: () => boolean;
}> = {}) {
    return {
        source: {
            release: { pluginId, version: sourceVersion },
            collectionContracts: sourceContracts,
        },
        target: {
            release: { pluginId, version: targetVersion },
            collectionContracts: overrides.targetContracts ?? targetRefs,
        },
        accountLifetime: lifetime(),
        isCurrent: overrides.isCurrent ?? (() => true),
    } as const;
}

describe('daemon Collection candidate preparation bridge', () => {
    beforeEach(() => {
        callGuardedMachineRpcWithPolicyMock.mockReset();
    });

    it('uses the verified daemon execution fact and retires only its exact returned bindings', async () => {
        callGuardedMachineRpcWithPolicyMock
            .mockResolvedValueOnce({ version: 1, kind: 'prepared', bindings: [binding] })
            .mockResolvedValueOnce({ version: 1, kind: 'retired' });
        const preparation = createDaemonCandidateCollectionReleasePreparation({ execution });

        const prepared = await preparation.prepare(input());

        expect(prepared).toMatchObject({ kind: 'prepared' });
        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: execution.origin.materializationRef.machineId,
            serverId: execution.serverId,
            method: RPC_METHODS.DAEMON_PLUGIN_COLLECTION_CANDIDATE_PREPARATION_EXECUTE,
            payload: {
                version: 1,
                daemonTarget: {
                    serverIdentityId: execution.origin.serverIdentityId,
                    machineId: execution.origin.materializationRef.machineId,
                },
                operation: 'prepare',
                source: input().source,
                candidate: {
                    release: input().target.release,
                    artifactDigest: execution.artifactGraph.digest,
                    origin: execution.origin,
                    collectionContracts: targetRefs,
                },
            },
        }));
        if (prepared.kind !== 'prepared') throw new Error('Expected prepared stage');
        await prepared.stage.retire();

        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: execution.origin.materializationRef.machineId,
            serverId: execution.serverId,
            method: RPC_METHODS.DAEMON_PLUGIN_COLLECTION_CANDIDATE_PREPARATION_EXECUTE,
            payload: {
                version: 1,
                daemonTarget: {
                    serverIdentityId: execution.origin.serverIdentityId,
                    machineId: execution.origin.materializationRef.machineId,
                },
                operation: 'retire',
                bindings: [binding],
            },
        }));
    });

    it('does not turn a target mismatch into a daemon execution attempt', async () => {
        const preparation = createDaemonCandidateCollectionReleasePreparation({ execution });

        await expect(preparation.prepare(input({
            targetContracts: [{
                ...targetRefs[0]!,
                contractDigest: `sha256:${'e'.repeat(64)}`,
            }],
        }))).resolves.toEqual({
            kind: 'unavailable',
            code: 'target_contract_mismatch',
        });
        expect(callGuardedMachineRpcWithPolicyMock).not.toHaveBeenCalled();
    });

    it('rejects a malformed daemon result that repeats one source binding and omits another', async () => {
        const source = input().source;
        const omittedSource = Object.freeze({
            ...source.collectionContracts[0]!,
            collectionId: 'notes',
            contractDigest: 'e'.repeat(43),
        });
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            version: 1,
            kind: 'prepared',
            bindings: [binding, binding],
        });
        const preparation = createDaemonCandidateCollectionReleasePreparation({ execution });

        await expect(preparation.prepare({
            ...input(),
            source: {
                ...source,
                collectionContracts: [...source.collectionContracts, omittedSource],
            },
        })).resolves.toEqual({
            kind: 'unavailable',
            code: 'target_contract_mismatch',
        });
    });

    it('retires a verified stage when the present selection goes stale during daemon preparation', async () => {
        let current = true;
        callGuardedMachineRpcWithPolicyMock.mockImplementationOnce(async () => {
            current = false;
            return { version: 1, kind: 'prepared', bindings: [binding] };
        }).mockResolvedValueOnce({ version: 1, kind: 'retired' });
        const preparation = createDaemonCandidateCollectionReleasePreparation({ execution });

        await expect(preparation.prepare(input({ isCurrent: () => current }))).resolves.toEqual({
            kind: 'unavailable',
            code: 'source_release_changed',
        });
        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledTimes(2);
        expect(callGuardedMachineRpcWithPolicyMock.mock.calls[1]?.[0]).toMatchObject({
            payload: { operation: 'retire', bindings: [binding] },
        });
    });
});
