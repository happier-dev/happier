import { describe, expect, it, vi } from 'vitest';

import {
    DaemonPluginCollectionCandidatePreparationRequestV1Schema,
} from '@happier-dev/protocol';

import { createDaemonPluginCollectionCandidatePreparationHandler } from './daemonPluginCollectionCandidatePreparation';

const daemonTarget = Object.freeze({
    serverIdentityId: 'srv_candidate_account',
    machineId: 'machine-candidate',
});

const sourceContract = Object.freeze({
    pluginId: 'acme.candidate-tasks',
    collectionId: 'tasks',
    schemaVersion: 1,
    migrations: [],
    contractDigest: 'a'.repeat(43),
    rowIdField: 'id',
    schema: {
        type: 'object' as const,
        properties: {
            id: { type: 'string' as const },
            title: { type: 'string' as const },
        },
        required: ['id', 'title'],
        additionalProperties: false,
    },
    serverReadable: ['id', 'title'],
    indexes: [],
    uiQueries: [],
    relations: [],
    readableSchemaVersions: [1],
});

const targetContract = Object.freeze({
    pluginId: sourceContract.pluginId,
    collectionId: sourceContract.collectionId,
    schemaVersion: 2,
    contractDigest: 'b'.repeat(43),
});

const candidate = Object.freeze({
    release: { pluginId: sourceContract.pluginId, version: '2.0.0' },
    artifactDigest: `sha256:${'c'.repeat(64)}`,
    origin: {
        serverIdentityId: daemonTarget.serverIdentityId,
        materializationRef: {
            pluginId: sourceContract.pluginId,
            machineId: daemonTarget.machineId,
            materializationId: 'candidate-materialization',
        },
    },
    collectionContracts: [targetContract],
});

const binding = Object.freeze({
    source: {
        pluginId: sourceContract.pluginId,
        collectionId: sourceContract.collectionId,
        schemaVersion: sourceContract.schemaVersion,
        contractDigest: sourceContract.contractDigest,
    },
    target: targetContract,
    candidate: {
        releaseVersion: candidate.release.version,
        artifactDigest: candidate.artifactDigest,
    },
});

const parsedPrepareRequest = DaemonPluginCollectionCandidatePreparationRequestV1Schema.parse({
    version: 1,
    daemonTarget,
    operation: 'prepare',
    source: {
        release: { pluginId: sourceContract.pluginId, version: '1.0.0' },
        collectionContracts: [sourceContract],
    },
    candidate,
});
if (parsedPrepareRequest.operation !== 'prepare') {
    throw new Error('Expected a candidate preparation request fixture');
}
const prepareRequest = parsedPrepareRequest;

describe('daemon Collection candidate-preparation RPC handler', () => {
    it('delegates one exact, current target request to the canonical runtime owner without forwarding an immutable generation id', async () => {
        const release = vi.fn(async () => {});
        const prepareCollectionMigrationCandidates = vi.fn(async (input) => {
            expect(input.source).toEqual(prepareRequest.source);
            expect(input.candidate).toEqual(prepareRequest.candidate);
            await expect(input.isRequestCurrent()).resolves.toBe(true);
            return { kind: 'prepared' as const, bindings: [binding] };
        });
        const handler = createDaemonPluginCollectionCandidatePreparationHandler({
            resolveCurrentTarget: async () => daemonTarget,
            acquireRuntimeRegistryLease: async () => ({
                registry: { prepareCollectionMigrationCandidates },
                release,
            }),
        });

        await expect(handler(prepareRequest, { signal: new AbortController().signal })).resolves.toEqual({
            version: 1,
            kind: 'prepared',
            bindings: [binding],
        });
        expect(prepareCollectionMigrationCandidates).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
    });

    it('rejects a stale route before a target callback can prepare Account Data stages', async () => {
        const prepareCollectionMigrationCandidates = vi.fn();
        const handler = createDaemonPluginCollectionCandidatePreparationHandler({
            resolveCurrentTarget: async () => ({
                ...daemonTarget,
                machineId: 'other-machine',
            }),
            acquireRuntimeRegistryLease: async () => ({
                registry: { prepareCollectionMigrationCandidates },
                release: async () => {},
            }),
        });

        await expect(handler(prepareRequest, { signal: new AbortController().signal })).resolves.toEqual({
            version: 1,
            kind: 'unavailable',
            code: 'daemon_target_mismatch',
        });
        expect(prepareCollectionMigrationCandidates).not.toHaveBeenCalled();
    });

    it('retires persisted bindings through the current Account owner without requiring the target module to remain executable', async () => {
        const retireCollectionMigrationCandidates = vi.fn(async (input) => {
            expect(input.bindings).toEqual([binding]);
            await expect(input.isRequestCurrent()).resolves.toBe(true);
        });
        const handler = createDaemonPluginCollectionCandidatePreparationHandler({
            resolveCurrentTarget: async () => daemonTarget,
            acquireRuntimeRegistryLease: async () => ({
                registry: { retireCollectionMigrationCandidates },
                release: async () => {},
            }),
        });
        const request = DaemonPluginCollectionCandidatePreparationRequestV1Schema.parse({
            version: 1,
            daemonTarget,
            operation: 'retire',
            bindings: [binding],
        });

        await expect(handler(request, { signal: new AbortController().signal })).resolves.toEqual({
            version: 1,
            kind: 'retired',
        });
        expect(retireCollectionMigrationCandidates).toHaveBeenCalledOnce();
    });
});
