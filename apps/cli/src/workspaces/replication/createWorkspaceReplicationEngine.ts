import { applyWorkspaceReplicationPlan } from './apply/applyWorkspaceReplicationPlan';
import { createWorkspaceReplicationBaselineStore } from './baseline/workspaceReplicationBaselineStore';
import { createWorkspaceReplicationCasStore } from './cas/workspaceReplicationCasStore';
import { createWorkspaceReplicationJobStore } from './jobs/workspaceReplicationJobStore';
import { createWorkspaceReplicationRelationshipStore } from './relationships/workspaceReplicationRelationshipStore';
import { scanWorkspaceManifestIntoCas } from './scan/scanWorkspaceManifestIntoCas';
import { WorkspaceReplicationError } from './workspaceReplicationError';
import { buildWorkspaceReplicationEngine } from './workspaceReplicationEngine';
import type {
    WorkspaceReplicationEngine,
    WorkspaceReplicationEngineDependencies,
    WorkspaceReplicationEngineInput,
} from './workspaceReplicationTypes';
import {
    createWorkspaceReplicationSourceOffer,
    createWorkspaceReplicationSourceOfferFromManifest,
} from './transport/createWorkspaceReplicationSourceOffer';
import { createWorkspaceReplicationSourceOfferFromExportArtifacts } from './transport/createWorkspaceReplicationSourceOfferFromExportArtifacts';
import { planWorkspaceReplicationMissingBlobs } from './transport/planWorkspaceReplicationMissingBlobs';
import { createWorkspaceReplicationTransfers } from './transport/workspaceReplicationTransfers';

export function createWorkspaceReplicationEngine(
    input: WorkspaceReplicationEngineInput,
    dependencies: WorkspaceReplicationEngineDependencies = {},
): WorkspaceReplicationEngine {
    const createCasStore = dependencies.createCasStore ?? createWorkspaceReplicationCasStore;
    const createRelationshipStore = dependencies.createRelationshipStore ?? createWorkspaceReplicationRelationshipStore;
    const createBaselineStore = dependencies.createBaselineStore ?? createWorkspaceReplicationBaselineStore;
    const createJobStore = dependencies.createJobStore ?? createWorkspaceReplicationJobStore;
    const createTransfers = dependencies.createTransfers ?? createWorkspaceReplicationTransfers;
    const createSourceOffer = dependencies.createSourceOffer ?? createWorkspaceReplicationSourceOffer;
    const createSourceOfferFromManifest =
        dependencies.createSourceOfferFromManifest ?? createWorkspaceReplicationSourceOfferFromManifest;
    const createSourceOfferFromExportArtifacts =
        dependencies.createSourceOfferFromExportArtifacts ?? createWorkspaceReplicationSourceOfferFromExportArtifacts;
    const scanManifest = dependencies.scanManifestIntoCas ?? scanWorkspaceManifestIntoCas;
    const planMissingBlobs = dependencies.planMissingBlobs ?? planWorkspaceReplicationMissingBlobs;
    const applyPlan = dependencies.applyPlan ?? applyWorkspaceReplicationPlan;

    try {
        const stores = {
            cas: createCasStore({ activeServerDir: input.activeServerDir }),
            relationships: createRelationshipStore({ activeServerDir: input.activeServerDir }),
            baselines: createBaselineStore({ activeServerDir: input.activeServerDir }),
            jobs: createJobStore({ activeServerDir: input.activeServerDir }),
        } as const;
        const transfers = createTransfers();

        return buildWorkspaceReplicationEngine({
            activeServerDir: input.activeServerDir,
            stores,
            transfers,
            operations: {
                createSourceOffer: async (operationInput) =>
                    await createSourceOffer({
                        activeServerDir: input.activeServerDir,
                        ...operationInput,
                    }),
                createSourceOfferFromManifest: async (operationInput) =>
                    await createSourceOfferFromManifest({
                        activeServerDir: input.activeServerDir,
                        ...operationInput,
                    }),
                createSourceOfferFromExportArtifacts: async (operationInput) =>
                    await createSourceOfferFromExportArtifacts({
                        activeServerDir: input.activeServerDir,
                        ...operationInput,
                    }),
                scanManifestIntoCas: async (operationInput) =>
                    await scanManifest({
                        activeServerDir: input.activeServerDir,
                        ...operationInput,
                    }),
                planMissingBlobs: async (operationInput) =>
                    await planMissingBlobs({
                        activeServerDir: input.activeServerDir,
                        ...operationInput,
                    }),
                applyPlan: async (operationInput) =>
                    await applyPlan({
                        activeServerDir: input.activeServerDir,
                        ...operationInput,
                    }),
            },
        });
    } catch (error) {
        throw new WorkspaceReplicationError({
            code: 'engine_initialization_failed',
            message: `Failed to create workspace replication engine for ${input.activeServerDir}`,
            cause: error,
        });
    }
}
