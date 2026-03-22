import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceReplicationBaselineStore } from './baseline/workspaceReplicationBaselineStore';
import type { WorkspaceReplicationCasStore } from './cas/workspaceReplicationCasStore';
import type { WorkspaceReplicationJobStore } from './jobs/workspaceReplicationJobStore';
import type {
    WorkspaceReplicationRelationshipRecord,
    WorkspaceReplicationRelationshipStore,
} from './relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationTransfers } from './transport/workspaceReplicationTransfers';

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
    it('creates store instances once and binds activeServerDir for engine operations', async () => {
        const activeServerDir = '/tmp/happier-active-server';
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
        const createTransfers = vi.fn(() => transfers);
        const createSourceOffer = vi.fn(async () => ({
            offerId: 'offer_1',
            relationshipId: 'rel_1',
            directionId: 'dir_1',
            sourceFingerprint: 'sha256:offer',
            manifest: { entries: [], fingerprint: 'sha256:offer' },
            blobIndex: [],
        }));
        const createSourceOfferFromManifest = vi.fn(async () => ({
            offerId: 'offer_2',
            relationshipId: 'rel_2',
            directionId: 'dir_2',
            sourceFingerprint: 'sha256:manifest',
            manifest: { entries: [], fingerprint: 'sha256:manifest' },
            blobIndex: [],
        }));
        const createSourceOfferFromExportArtifacts = vi.fn(async () => ({
            offerId: 'offer_3',
            relationshipId: 'rel_3',
            directionId: 'dir_3',
            sourceFingerprint: 'sha256:artifacts',
            manifest: { entries: [], fingerprint: 'sha256:artifacts' },
            blobIndex: [],
        }));
        const scanManifestIntoCas = vi.fn(async () => ({
            entries: [],
            fingerprint: 'sha256:scan',
        }));
        const planMissingBlobs = vi.fn(async () => ({
            missingBlobs: [],
            plannedFileCount: 0,
            plannedByteCount: 0,
            alreadyPresentFileCount: 0,
            alreadyPresentByteCount: 0,
        }));
        const applyPlan = vi.fn(async ({ targetPath }: Readonly<{ targetPath: string }>) => ({
            targetPath,
        }));

        const { createWorkspaceReplicationEngine } = await import('./createWorkspaceReplicationEngine');

        const engine = createWorkspaceReplicationEngine(
            { activeServerDir },
            {
                createCasStore,
                createRelationshipStore,
                createBaselineStore,
                createJobStore,
                createTransfers,
                createSourceOffer,
                createSourceOfferFromManifest,
                createSourceOfferFromExportArtifacts,
                scanManifestIntoCas,
                planMissingBlobs,
                applyPlan,
            },
        );

        expect(createCasStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createRelationshipStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createBaselineStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createJobStore).toHaveBeenCalledWith({ activeServerDir });
        expect(createTransfers).toHaveBeenCalledTimes(1);
        expect(engine.activeServerDir).toBe(activeServerDir);
        expect(engine.stores).toEqual(stores);
        expect(engine.transfers).toBe(transfers);

        await engine.operations.createSourceOffer({
            source: { machineId: 'source', rootPath: '/source' },
            target: { machineId: 'target', rootPath: '/target' },
            mode: 'one_way_safe',
        });
        expect(createSourceOffer).toHaveBeenCalledWith({
            activeServerDir,
            source: { machineId: 'source', rootPath: '/source' },
            target: { machineId: 'target', rootPath: '/target' },
            mode: 'one_way_safe',
        });

        await engine.operations.createSourceOfferFromManifest({
            source: { machineId: 'source', rootPath: '/source' },
            target: { machineId: 'target', rootPath: '/target' },
            mode: 'one_way_safe',
            manifest: { entries: [], fingerprint: 'sha256:manifest' },
        });
        expect(createSourceOfferFromManifest).toHaveBeenCalledWith({
            activeServerDir,
            source: { machineId: 'source', rootPath: '/source' },
            target: { machineId: 'target', rootPath: '/target' },
            mode: 'one_way_safe',
            manifest: { entries: [], fingerprint: 'sha256:manifest' },
        });

        await engine.operations.createSourceOfferFromExportArtifacts({
            source: { machineId: 'source', rootPath: '/source' },
            target: { machineId: 'target', rootPath: '/target' },
            mode: 'one_way_safe',
            workspaceExportArtifacts: {
                manifest: { entries: [], fingerprint: 'sha256:artifacts' },
                blobContentsByDigest: new Map(),
            },
        });
        expect(createSourceOfferFromExportArtifacts).toHaveBeenCalledWith({
            activeServerDir,
            source: { machineId: 'source', rootPath: '/source' },
            target: { machineId: 'target', rootPath: '/target' },
            mode: 'one_way_safe',
            workspaceExportArtifacts: {
                manifest: { entries: [], fingerprint: 'sha256:artifacts' },
                blobContentsByDigest: new Map(),
            },
        });

        await engine.operations.scanManifestIntoCas({
            relationshipId: 'rel_1',
            workspaceRoot: '/source',
        });
        expect(scanManifestIntoCas).toHaveBeenCalledWith({
            activeServerDir,
            relationshipId: 'rel_1',
            workspaceRoot: '/source',
        });

        await engine.operations.planMissingBlobs({
            blobIndex: [],
        });
        expect(planMissingBlobs).toHaveBeenCalledWith({
            activeServerDir,
            blobIndex: [],
        });

        await engine.operations.applyPlan({
            sourceOffer: {
                offerId: 'offer_1',
                relationshipId: 'rel_1',
                directionId: 'dir_1',
                sourceFingerprint: 'sha256:offer',
                manifest: { entries: [], fingerprint: 'sha256:offer' },
                blobIndex: [],
            },
            targetPath: '/target',
            strategy: 'sync_changes',
            conflictPolicy: 'replace_existing',
        });
        expect(applyPlan).toHaveBeenCalledWith({
            activeServerDir,
            sourceOffer: {
                offerId: 'offer_1',
                relationshipId: 'rel_1',
                directionId: 'dir_1',
                sourceFingerprint: 'sha256:offer',
                manifest: { entries: [], fingerprint: 'sha256:offer' },
                blobIndex: [],
            },
            targetPath: '/target',
            strategy: 'sync_changes',
            conflictPolicy: 'replace_existing',
        });
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
                { activeServerDir: '/tmp/happier-active-server' },
                {
                    createCasStore,
                    createRelationshipStore: vi.fn(() => createStubRelationshipStore()),
                    createBaselineStore: vi.fn(() => createStubBaselineStore()),
                    createJobStore: vi.fn(() => createStubJobStore()),
                    createTransfers: vi.fn(() => createStubTransfers()),
                },
            ),
        ).toThrowError(WorkspaceReplicationError);

        try {
            createWorkspaceReplicationEngine(
                { activeServerDir: '/tmp/happier-active-server' },
                {
                    createCasStore,
                    createRelationshipStore: vi.fn(() => createStubRelationshipStore()),
                    createBaselineStore: vi.fn(() => createStubBaselineStore()),
                    createJobStore: vi.fn(() => createStubJobStore()),
                    createTransfers: vi.fn(() => createStubTransfers()),
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
