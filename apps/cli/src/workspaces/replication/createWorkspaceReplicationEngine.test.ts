import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceReplicationBaselineStore } from './baseline/workspaceReplicationBaselineStore';
import type { WorkspaceReplicationCasStore } from './cas/workspaceReplicationCasStore';
import type { WorkspaceReplicationJobRecord, WorkspaceReplicationJobStore } from './jobs/workspaceReplicationJobStore';
import type {
    WorkspaceReplicationRelationshipRecord,
    WorkspaceReplicationRelationshipStore,
} from './relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationTransfers } from './transport/workspaceReplicationTransfers';
import {
    buildWorkspaceReplicationDirectionId,
} from './relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationDirectionScope } from './relationships/relationshipScope';

const relationshipRecord: WorkspaceReplicationRelationshipRecord = {
    schemaVersion: 1,
    relationshipId: 'rel_stub',
    endpoints: [
        { machineId: 'source', rootPath: '/source' },
        { machineId: 'target', rootPath: '/target' },
    ],
    config: { mode: 'one_way_safe' },
    createdAtMs: 1,
    updatedAtMs: 1,
};

function createStubCasStore(): WorkspaceReplicationCasStore {
    return {
        contains: vi.fn(async () => false),
        commitFile: vi.fn(async () => ({
            digest: 'sha256:stub',
            blobPath: '/tmp/blob',
            sizeBytes: 0,
        })),
        openReadStream: vi.fn(() => {
            throw new Error('not used in test');
        }),
        resolveBlobPath: vi.fn(() => '/tmp/blob'),
    };
}

function createStubRelationshipStore(): WorkspaceReplicationRelationshipStore {
    return {
        upsert: vi.fn(async () => relationshipRecord),
        ensureRelationship: vi.fn(async () => relationshipRecord),
        read: vi.fn(async () => null),
        readByScope: vi.fn(async () => null),
        readById: vi.fn(async () => null),
        resolveFilePath: vi.fn(() => '/tmp/relationship.json'),
        resolveRelationshipDirectory: vi.fn(() => '/tmp/relationship'),
        resolveBaselinePath: vi.fn(() => '/tmp/baseline.json'),
    };
}

function createStubBaselineStore(): WorkspaceReplicationBaselineStore {
    return {
        load: vi.fn(async () => null),
        save: vi.fn(async () => undefined),
        resolveFilePath: vi.fn(() => '/tmp/baseline.json'),
    };
}

function createStubJobStore(): WorkspaceReplicationJobStore {
    return {
        write: vi.fn(async () => undefined),
        read: vi.fn(async () => null),
        findByCorrelationId: vi.fn(async () => null),
        update: vi.fn(async () => null),
    };
}

function createStubTransfers(): WorkspaceReplicationTransfers {
    return {
        publishDirectPeerSourceOffer: vi.fn(() => []),
        requestDirectPeerSourceOffer: vi.fn(async () => {
            throw new Error('not used in test');
        }),
        requestServerRoutedSourceOffer: vi.fn(async () => {
            throw new Error('not used in test');
        }),
        publishDirectPeerBlobPack: vi.fn(() => []),
        requestDirectPeerBlobPackToFile: vi.fn(async () => ({
            destinationPath: '/tmp/blob-pack.bin',
            manifestHash: 'sha256:00',
            sizeBytes: 0,
        })),
        requestServerRoutedBlobPackToFile: vi.fn(async () => ({
            destinationPath: '/tmp/blob-pack.bin',
            manifestHash: 'sha256:00',
            sizeBytes: 0,
        })),
    };
}

describe('createWorkspaceReplicationEngine', () => {
    it('creates store instances once and exposes the stable engine surface', async () => {
        const activeServerDir = '/tmp/happier-active-server';
        const localMachineId = 'machine_local';
        const stores = {
            cas: createStubCasStore(),
            relationships: createStubRelationshipStore(),
            baselines: createStubBaselineStore(),
            jobs: createStubJobStore(),
        };
        const transfers = createStubTransfers();
        const createCasStore = vi.fn(() => stores.cas);
        const createRelationshipStore = vi.fn(() => stores.relationships);
        const createBaselineStore = vi.fn(() => stores.baselines);
        const createJobStore = vi.fn(() => stores.jobs);
        const createSourceOffer = vi.fn(async () => ({
            offerId: 'offer_1',
            relationshipId: 'rel_1',
            directionId: 'dir_1',
            sourceFingerprint: 'sha256:offer',
            manifest: { entries: [], fingerprint: 'sha256:offer' },
            blobIndex: [],
        }));
        const executeJobInBackground = vi.fn();

        const { createWorkspaceReplicationEngine } = await import('./createWorkspaceReplicationEngine');

        const engine: unknown = createWorkspaceReplicationEngine(
            { activeServerDir, localMachineId, transfers },
            {
                createCasStore,
                createRelationshipStore,
                createBaselineStore,
                createJobStore,
                createSourceOffer,
                executeJobInBackground,
            },
        );

        expect(createCasStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createRelationshipStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createBaselineStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createJobStore).toHaveBeenCalledWith({ activeServerDir });
        expect(engine).toBeTruthy();

        const engineObject = engine as Record<string, unknown>;
        expect(engineObject.activeServerDir).toBe(activeServerDir);
        expect(engineObject.localMachineId).toBe(localMachineId);
        expect(typeof engineObject.resolveRelationship).toBe('function');
        expect(typeof engineObject.plan).toBe('function');
        expect(typeof engineObject.createSourceOffer).toBe('function');
        expect(typeof engineObject.startJobFromOffer).toBe('function');
        expect(typeof engineObject.getJobStatus).toBe('function');
        expect(typeof engineObject.listJobs).toBe('function');
        expect(typeof engineObject.abortJob).toBe('function');
        expect(typeof engineObject.gc).toBe('function');

        const directionScope: WorkspaceReplicationDirectionScope = {
            sourceMachineId: 'source',
            sourceWorkspaceRoot: '/source',
            targetMachineId: 'target',
            targetWorkspaceRoot: '/target',
            mode: 'one_way_safe',
            ignorePatterns: ['node_modules/**'],
        };

        const resolveRelationship = engineObject.resolveRelationship as (
            scope: WorkspaceReplicationDirectionScope,
        ) => Promise<unknown>;
        await resolveRelationship(directionScope);
        expect(stores.relationships.ensureRelationship).toHaveBeenCalledWith(directionScope);
        expect(stores.baselines.load).toHaveBeenCalledWith(directionScope);

        const createSourceOfferOperation = engineObject.createSourceOffer as (
            scope: WorkspaceReplicationDirectionScope,
        ) => Promise<unknown>;
        await createSourceOfferOperation(directionScope);
        expect(createSourceOffer).toHaveBeenCalledWith({
            activeServerDir,
            source: { machineId: 'source', rootPath: '/source' },
            target: { machineId: 'target', rootPath: '/target' },
            mode: 'one_way_safe',
            ignorePatterns: ['node_modules/**'],
        });

        const existingJobRecord: WorkspaceReplicationJobRecord = {
            schemaVersion: 1,
            jobId: 'job_stub',
            correlationId: 'corr_stub',
            relationshipId: relationshipRecord.relationshipId,
            directionId: buildWorkspaceReplicationDirectionId(directionScope),
            offerId: 'offer_stub',
            mode: 'one_way_safe',
            createdAtMs: 1,
            updatedAtMs: 1,
            status: {
                status: 'pending',
                phase: 'planning',
                checkpoint: 'job_created',
                progressCounters: {
                    plannedFiles: 0,
                    plannedBytes: 0,
                    transferredFiles: 0,
                    transferredBytes: 0,
                    appliedFiles: 0,
                    appliedBytes: 0,
                },
                warnings: [],
                blockingDivergenceCandidates: [],
            },
        };

        const getJobStatus = engineObject.getJobStatus as (jobId: string) => Promise<WorkspaceReplicationJobRecord>;
        (stores.jobs.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existingJobRecord);
        await expect(getJobStatus('job_stub')).resolves.toMatchObject({ jobId: 'job_stub' });

        const { WorkspaceReplicationError } = await import('./workspaceReplicationError');
        (stores.jobs.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
        await expect(getJobStatus('job_missing')).rejects.toBeInstanceOf(WorkspaceReplicationError);

        type StartJobFromOfferInput = Readonly<{
            scope: WorkspaceReplicationDirectionScope;
            sourceOffer: Readonly<{
                offerId: string;
                relationshipId: string;
                directionId: string;
                sourceFingerprint: string;
                manifest: Readonly<{ entries: readonly unknown[]; fingerprint: string }>;
                blobIndex: readonly unknown[];
            }>;
            apply: Readonly<{
                targetPath: string;
                strategy: 'sync_changes';
                conflictPolicy: 'replace_existing';
            }>;
            requestBlobPackToFile: (input: Readonly<{
                packId: string;
                digests: readonly string[];
                destinationPath: string;
            }>) => Promise<void>;
            correlationId: string;
        }>;

        const startJobFromOffer = engineObject.startJobFromOffer as (input: StartJobFromOfferInput) => Promise<unknown>;
        await startJobFromOffer({
            scope: directionScope,
            sourceOffer: {
                offerId: 'offer_stub',
                relationshipId: relationshipRecord.relationshipId,
                directionId: buildWorkspaceReplicationDirectionId(directionScope),
                sourceFingerprint: 'sha256:offer',
                manifest: { entries: [], fingerprint: 'sha256:offer' },
                blobIndex: [],
            },
            apply: {
                targetPath: '/target',
                strategy: 'sync_changes',
                conflictPolicy: 'replace_existing',
            },
            requestBlobPackToFile: vi.fn(async () => undefined),
            correlationId: 'corr_stub',
        });
        expect(stores.jobs.write).toHaveBeenCalled();
        expect(executeJobInBackground).toHaveBeenCalled();
    });

    it('wraps store initialization failures in a workspace replication error', async () => {
        const cause = new Error('boom');
        const createCasStore = vi.fn(() => {
            throw cause;
        });

        const { createWorkspaceReplicationEngine } = await import('./createWorkspaceReplicationEngine');
        const { WorkspaceReplicationError } = await import('./workspaceReplicationError');

        expect(() =>
            createWorkspaceReplicationEngine(
                {
                    activeServerDir: '/tmp/happier-active-server',
                    localMachineId: 'machine_local',
                    transfers: createStubTransfers(),
                },
                {
                    createCasStore,
                    createRelationshipStore: vi.fn(() => createStubRelationshipStore()),
                    createBaselineStore: vi.fn(() => createStubBaselineStore()),
                    createJobStore: vi.fn(() => createStubJobStore()),
                },
            ),
        ).toThrowError(WorkspaceReplicationError);

        try {
            createWorkspaceReplicationEngine(
                {
                    activeServerDir: '/tmp/happier-active-server',
                    localMachineId: 'machine_local',
                    transfers: createStubTransfers(),
                },
                {
                    createCasStore,
                    createRelationshipStore: vi.fn(() => createStubRelationshipStore()),
                    createBaselineStore: vi.fn(() => createStubBaselineStore()),
                    createJobStore: vi.fn(() => createStubJobStore()),
                },
            );
            throw new Error('expected engine creation to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(WorkspaceReplicationError);
            expect(error).toMatchObject({
                code: 'engine_initialization_failed',
                cause,
            });
        }
    });
});
