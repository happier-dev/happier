import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { WorkspaceReplicationBaselineStore } from './baseline/workspaceReplicationBaselineStore';
import type { WorkspaceReplicationCasStore } from './cas/workspaceReplicationCasStore';
import type { WorkspaceReplicationJobRecord, WorkspaceReplicationJobStore } from './jobs/workspaceReplicationJobStore';
import type {
    WorkspaceReplicationRelationshipRecord,
    WorkspaceReplicationRelationshipStore,
} from './relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationSourceOfferStore } from './transport/workspaceReplicationSourceOfferStore';
import type { WorkspaceReplicationEngineDependencies } from './workspaceReplicationTypes';
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

function createStubSourceOfferStore(): WorkspaceReplicationSourceOfferStore {
    return {
        write: vi.fn(async () => ({ filePath: '/tmp/offer.txt', sizeBytes: 0 })),
        read: vi.fn(async () => null),
        resolveFilePath: vi.fn(() => '/tmp/offer.txt'),
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
            sourceOffers: createStubSourceOfferStore(),
        };
        const createCasStore = vi.fn(() => stores.cas);
        const createRelationshipStore = vi.fn(() => stores.relationships);
        const createBaselineStore = vi.fn(() => stores.baselines);
        const createJobStore = vi.fn(() => stores.jobs);
        const createSourceOfferStore = vi.fn(() => stores.sourceOffers);
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
            { activeServerDir, localMachineId },
            {
                createCasStore,
                createRelationshipStore,
                createBaselineStore,
                createJobStore,
                createSourceOfferStore,
                createSourceOffer,
                executeJobInBackground,
            },
        );

        expect(createCasStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createRelationshipStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createBaselineStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createJobStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createSourceOfferStore).toHaveBeenCalledWith({ activeServerDir });
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
        expect(stores.sourceOffers.write).toHaveBeenCalled();
        expect(stores.jobs.write).toHaveBeenCalledWith(expect.objectContaining({
            jobId: expect.any(String),
            resumeContext: {
                apply: {
                    targetPath: '/target',
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                },
            },
        }));
        expect(executeJobInBackground).toHaveBeenCalled();
    });

    it('derives the target scan safe-filter policy from source manifests that include administrative paths', async () => {
        const activeServerDir = '/tmp/happier-active-server';
        const localMachineId = 'machine_local';
        const stores = {
            cas: createStubCasStore(),
            relationships: createStubRelationshipStore(),
            baselines: createStubBaselineStore(),
            jobs: createStubJobStore(),
            sourceOffers: createStubSourceOfferStore(),
        };
        const scannedTargetManifest: Awaited<ReturnType<NonNullable<WorkspaceReplicationEngineDependencies['scanManifestIntoCas']>>> = {
            entries: [
                {
                    kind: 'directory',
                    relativePath: '.git',
                },
                {
                    kind: 'file',
                    relativePath: '.git/HEAD',
                    digest: 'sha256:head',
                    sizeBytes: 20,
                    executable: false,
                },
                {
                    kind: 'file',
                    relativePath: 'README.md',
                    digest: 'sha256:readme',
                    sizeBytes: 6,
                    executable: false,
                },
            ],
            fingerprint: 'sha256:target',
        };
        const scanManifestIntoCasSpy = vi.fn();
        const scanManifestIntoCas: NonNullable<WorkspaceReplicationEngineDependencies['scanManifestIntoCas']> =
            async (params) => {
                scanManifestIntoCasSpy(params);
                return scannedTargetManifest;
            };

        const { createWorkspaceReplicationEngine } = await import('./createWorkspaceReplicationEngine');
        const engine = createWorkspaceReplicationEngine(
            { activeServerDir, localMachineId },
            {
                createCasStore: () => stores.cas,
                createRelationshipStore: () => stores.relationships,
                createBaselineStore: () => stores.baselines,
                createJobStore: () => stores.jobs,
                createSourceOfferStore: () => stores.sourceOffers,
                scanManifestIntoCas,
            },
        );

        const directionScope: WorkspaceReplicationDirectionScope = {
            sourceMachineId: 'source',
            sourceWorkspaceRoot: '/source',
            targetMachineId: 'target',
            targetWorkspaceRoot: '/target',
            mode: 'one_way_safe',
        };

        await engine.plan({
            scope: directionScope,
            sourceManifest: {
                entries: [
                    {
                        kind: 'directory',
                        relativePath: '.git',
                    },
                    {
                        kind: 'file',
                        relativePath: '.git/HEAD',
                        digest: 'sha256:head',
                        sizeBytes: 20,
                        executable: false,
                    },
                    {
                        kind: 'file',
                        relativePath: 'README.md',
                        digest: 'sha256:readme',
                        sizeBytes: 6,
                        executable: false,
                    },
                ],
                fingerprint: 'sha256:source',
            },
            targetWorkspaceRoot: '/target',
        });

        expect(scanManifestIntoCasSpy).toHaveBeenCalledWith(expect.objectContaining({
            activeServerDir,
            relationshipId: relationshipRecord.relationshipId,
            workspaceRoot: '/target',
            safeFilterPolicy: {
                excludeAdministrativePaths: false,
            },
        }));
    });

    it('reuses an existing in-flight job when correlationId matches (daemon-restart resumability)', async () => {
        const activeServerDir = '/tmp/happier-active-server';
        const localMachineId = 'machine_local';
        const executeJobInBackground = vi.fn(() => undefined);
        const directionScope: WorkspaceReplicationDirectionScope = {
            sourceMachineId: 'source',
            sourceWorkspaceRoot: '/source',
            targetMachineId: 'target',
            targetWorkspaceRoot: '/target',
            mode: 'one_way_safe',
        };

        const stores = {
            cas: createStubCasStore(),
            relationships: createStubRelationshipStore(),
            baselines: createStubBaselineStore(),
            jobs: createStubJobStore(),
            sourceOffers: createStubSourceOfferStore(),
        };
        const existingJobRecord: WorkspaceReplicationJobRecord = {
            schemaVersion: 1,
            jobId: 'job_existing',
            correlationId: 'corr_existing',
            relationshipId: relationshipRecord.relationshipId,
            directionId: buildWorkspaceReplicationDirectionId(directionScope),
            offerId: 'offer_stub',
            mode: 'one_way_safe',
            createdAtMs: 1,
            updatedAtMs: 2,
            status: {
                status: 'pending',
                phase: 'planning',
                checkpoint: 'relationship_resolved',
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
        (stores.jobs.findByCorrelationId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existingJobRecord);

        const { createWorkspaceReplicationEngine } = await import('./createWorkspaceReplicationEngine');
        const engine = createWorkspaceReplicationEngine(
            { activeServerDir, localMachineId },
            {
                createCasStore: () => stores.cas,
                createRelationshipStore: () => stores.relationships,
                createBaselineStore: () => stores.baselines,
                createJobStore: () => stores.jobs,
                createSourceOfferStore: () => stores.sourceOffers,
                executeJobInBackground,
            },
        );

        const started = await engine.startJobFromOffer({
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
            correlationId: 'corr_existing',
        });

        expect(stores.jobs.write).not.toHaveBeenCalled();
        expect(started).toMatchObject({
            jobId: 'job_existing',
            initialStatus: {
                jobId: 'job_existing',
            },
        });
        expect(executeJobInBackground).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job_existing' }));
    });

    it('plans with an administrative-path-aware target scan when the source manifest includes git metadata', async () => {
        const activeServerDir = '/tmp/happier-active-server';
        const localMachineId = 'machine_local';
        const stores = {
            cas: createStubCasStore(),
            relationships: createStubRelationshipStore(),
            baselines: createStubBaselineStore(),
            jobs: createStubJobStore(),
            sourceOffers: createStubSourceOfferStore(),
        };
        const scannedTargetManifest = {
            entries: [
                { kind: 'directory' as const, relativePath: '.git' },
                {
                    kind: 'file' as const,
                    relativePath: '.git/HEAD',
                    digest: 'sha256:head',
                    sizeBytes: 23,
                    executable: false,
                },
                {
                    kind: 'file' as const,
                    relativePath: 'README.md',
                    digest: 'sha256:readme',
                    sizeBytes: 7,
                    executable: false,
                },
            ],
            fingerprint: 'sha256:target',
        };
        const scanManifestIntoCas: NonNullable<WorkspaceReplicationEngineDependencies['scanManifestIntoCas']> =
            vi.fn(async (_params) => scannedTargetManifest);

        const { createWorkspaceReplicationEngine } = await import('./createWorkspaceReplicationEngine');
        const engine = createWorkspaceReplicationEngine(
            { activeServerDir, localMachineId },
            {
                createCasStore: () => stores.cas,
                createRelationshipStore: () => stores.relationships,
                createBaselineStore: () => stores.baselines,
                createJobStore: () => stores.jobs,
                createSourceOfferStore: () => stores.sourceOffers,
                scanManifestIntoCas,
            },
        );

        await engine.plan({
            scope: {
                sourceMachineId: 'source',
                sourceWorkspaceRoot: '/source',
                targetMachineId: 'target',
                targetWorkspaceRoot: '/target',
                mode: 'one_way_safe',
            },
            sourceManifest: {
                entries: [
                    { kind: 'directory', relativePath: '.git' },
                    {
                        kind: 'file',
                        relativePath: '.git/HEAD',
                        digest: 'sha256:head',
                        sizeBytes: 23,
                        executable: false,
                    },
                    {
                        kind: 'file',
                        relativePath: 'README.md',
                        digest: 'sha256:readme',
                        sizeBytes: 7,
                        executable: false,
                    },
                ],
                fingerprint: 'sha256:source',
            },
            targetWorkspaceRoot: '/target',
        });

        expect(scanManifestIntoCas).toHaveBeenCalledWith({
            activeServerDir,
            relationshipId: relationshipRecord.relationshipId,
            workspaceRoot: '/target',
            safeFilterPolicy: { excludeAdministrativePaths: false },
            scmRegistry: undefined,
        });
    });

    it('fails closed when correlationId reuses an in-flight job with a different durable resume context', async () => {
        const activeServerDir = '/tmp/happier-active-server';
        const localMachineId = 'machine_local';
        const directionScope: WorkspaceReplicationDirectionScope = {
            sourceMachineId: 'source',
            sourceWorkspaceRoot: '/source',
            targetMachineId: 'target',
            targetWorkspaceRoot: '/target',
            mode: 'one_way_safe',
        };

        const stores = {
            cas: createStubCasStore(),
            relationships: createStubRelationshipStore(),
            baselines: createStubBaselineStore(),
            jobs: createStubJobStore(),
            sourceOffers: createStubSourceOfferStore(),
        };
        (stores.jobs.findByCorrelationId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            schemaVersion: 1,
            jobId: 'job_resume_mismatch',
            correlationId: 'corr_resume_mismatch',
            relationshipId: relationshipRecord.relationshipId,
            directionId: buildWorkspaceReplicationDirectionId(directionScope),
            offerId: 'offer_stub',
            mode: 'one_way_safe',
            createdAtMs: 1,
            updatedAtMs: 2,
            resumeContext: {
                apply: {
                    targetPath: '/old-target',
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                },
            },
            status: {
                status: 'pending',
                phase: 'planning',
                checkpoint: 'relationship_resolved',
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
        });

        const { createWorkspaceReplicationEngine } = await import('./createWorkspaceReplicationEngine');
        const engine = createWorkspaceReplicationEngine(
            { activeServerDir, localMachineId },
            {
                createCasStore: () => stores.cas,
                createRelationshipStore: () => stores.relationships,
                createBaselineStore: () => stores.baselines,
                createJobStore: () => stores.jobs,
                createSourceOfferStore: () => stores.sourceOffers,
                executeJobInBackground: vi.fn(),
            },
        );

        await expect(engine.startJobFromOffer({
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
                targetPath: '/new-target',
                strategy: 'sync_changes',
                conflictPolicy: 'replace_existing',
            },
            requestBlobPackToFile: vi.fn(async () => undefined),
            correlationId: 'corr_resume_mismatch',
        })).rejects.toThrow(/resume context/i);
    });

    it('fails closed when correlationId is already in use for a different in-flight offer', async () => {
        const activeServerDir = '/tmp/happier-active-server';
        const localMachineId = 'machine_local';
        const directionScope: WorkspaceReplicationDirectionScope = {
            sourceMachineId: 'source',
            sourceWorkspaceRoot: '/source',
            targetMachineId: 'target',
            targetWorkspaceRoot: '/target',
            mode: 'one_way_safe',
        };

        const stores = {
            cas: createStubCasStore(),
            relationships: createStubRelationshipStore(),
            baselines: createStubBaselineStore(),
            jobs: createStubJobStore(),
            sourceOffers: createStubSourceOfferStore(),
        };
        const existingJobRecord: WorkspaceReplicationJobRecord = {
            schemaVersion: 1,
            jobId: 'job_existing',
            correlationId: 'corr_existing',
            relationshipId: relationshipRecord.relationshipId,
            directionId: buildWorkspaceReplicationDirectionId(directionScope),
            offerId: 'offer_old',
            mode: 'one_way_safe',
            createdAtMs: 1,
            updatedAtMs: 2,
            status: {
                status: 'in_progress',
                phase: 'planning',
                checkpoint: 'relationship_resolved',
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
        (stores.jobs.findByCorrelationId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existingJobRecord);

        const { createWorkspaceReplicationEngine } = await import('./createWorkspaceReplicationEngine');
        const engine = createWorkspaceReplicationEngine(
            { activeServerDir, localMachineId },
            {
                createCasStore: () => stores.cas,
                createRelationshipStore: () => stores.relationships,
                createBaselineStore: () => stores.baselines,
                createJobStore: () => stores.jobs,
                createSourceOfferStore: () => stores.sourceOffers,
                executeJobInBackground: () => undefined,
            },
        );

        await expect(engine.startJobFromOffer({
            scope: directionScope,
            sourceOffer: {
                offerId: 'offer_new',
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
            correlationId: 'corr_existing',
        })).rejects.toThrow(/correlationId/i);
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

    it('persists started job source offers to disk in a streaming offer format (restart-safe offer resolution)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-wsrepl-engine-offer-store-'));
        try {
            const { createWorkspaceReplicationEngine } = await import('./createWorkspaceReplicationEngine');
            const {
                isStreamingWorkspaceReplicationSourceOfferFile,
                readWorkspaceReplicationSourceOfferFromFile,
            } = await import('./transport/workspaceReplicationSourceOfferFileFormat');

            const sourceOffer = {
                offerId: 'offer_store_1',
                relationshipId: 'rel_store_1',
                directionId: 'dir_store_1',
                sourceFingerprint: `sha256:${'a'.repeat(64)}`,
                manifest: { entries: [], fingerprint: `sha256:${'a'.repeat(64)}` },
                blobIndex: [],
            };

            const engine = createWorkspaceReplicationEngine(
                { activeServerDir, localMachineId: 'machine_local' },
                { executeJobInBackground: () => {} },
            );

            await engine.startJobFromOffer({
                scope: {
                    sourceMachineId: 'source',
                    sourceWorkspaceRoot: '/source',
                    targetMachineId: 'target',
                    targetWorkspaceRoot: '/target',
                    mode: 'one_way_safe',
                },
                sourceOffer,
                apply: {
                    targetPath: '/target',
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                },
                requestBlobPackToFile: async () => undefined,
                correlationId: 'corr_offer_store',
            });

            const offersDirectory = join(activeServerDir, 'workspace-replication', 'offers');
            const entries = await readdir(offersDirectory);
            const offerFileName = entries.find((name) => name.includes(sourceOffer.offerId));
            expect(offerFileName).toBeTruthy();

            const offerFilePath = join(offersDirectory, offerFileName!);
            expect(await isStreamingWorkspaceReplicationSourceOfferFile(offerFilePath)).toBe(true);
            const parsed = await readWorkspaceReplicationSourceOfferFromFile({
                transferId: sourceOffer.offerId,
                filePath: offerFilePath,
            });
            expect(parsed.offerId).toBe(sourceOffer.offerId);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });
});
