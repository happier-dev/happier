import type { WorkspaceReplicationBaselineStore } from './baseline/workspaceReplicationBaselineStore';
import type { WorkspaceReplicationCasStore } from './cas/workspaceReplicationCasStore';
import type { WorkspaceReplicationJobStore } from './jobs/workspaceReplicationJobStore';
import type { WorkspaceReplicationRelationshipStore } from './relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationTransfers } from './transport/workspaceReplicationTransfers';

type CreateWorkspaceReplicationBaselineStore = typeof import('./baseline/workspaceReplicationBaselineStore').createWorkspaceReplicationBaselineStore;
type CreateWorkspaceReplicationCasStore = typeof import('./cas/workspaceReplicationCasStore').createWorkspaceReplicationCasStore;
type CreateWorkspaceReplicationJobStore = typeof import('./jobs/workspaceReplicationJobStore').createWorkspaceReplicationJobStore;
type CreateWorkspaceReplicationRelationshipStore = typeof import('./relationships/workspaceReplicationRelationshipStore').createWorkspaceReplicationRelationshipStore;
type CreateWorkspaceReplicationTransfers = typeof import('./transport/workspaceReplicationTransfers').createWorkspaceReplicationTransfers;
type CreateWorkspaceReplicationSourceOffer = typeof import('./transport/createWorkspaceReplicationSourceOffer').createWorkspaceReplicationSourceOffer;
type CreateWorkspaceReplicationSourceOfferFromManifest =
    typeof import('./transport/createWorkspaceReplicationSourceOffer').createWorkspaceReplicationSourceOfferFromManifest;
type CreateWorkspaceReplicationSourceOfferFromExportArtifacts =
    typeof import('./transport/createWorkspaceReplicationSourceOfferFromExportArtifacts').createWorkspaceReplicationSourceOfferFromExportArtifacts;
type ScanWorkspaceManifestIntoCas = typeof import('./scan/scanWorkspaceManifestIntoCas').scanWorkspaceManifestIntoCas;
type PlanWorkspaceReplicationMissingBlobs =
    typeof import('./transport/planWorkspaceReplicationMissingBlobs').planWorkspaceReplicationMissingBlobs;
type ApplyWorkspaceReplicationPlan = typeof import('./apply/applyWorkspaceReplicationPlan').applyWorkspaceReplicationPlan;

export type WorkspaceReplicationEngineInput = Readonly<{
    activeServerDir: string;
}>;

export type WorkspaceReplicationEngineStores = Readonly<{
    cas: WorkspaceReplicationCasStore;
    relationships: WorkspaceReplicationRelationshipStore;
    baselines: WorkspaceReplicationBaselineStore;
    jobs: WorkspaceReplicationJobStore;
}>;

export type WorkspaceReplicationEngineDependencies = Readonly<{
    createCasStore?: CreateWorkspaceReplicationCasStore;
    createRelationshipStore?: CreateWorkspaceReplicationRelationshipStore;
    createBaselineStore?: CreateWorkspaceReplicationBaselineStore;
    createJobStore?: CreateWorkspaceReplicationJobStore;
    createTransfers?: CreateWorkspaceReplicationTransfers;
    createSourceOffer?: CreateWorkspaceReplicationSourceOffer;
    createSourceOfferFromManifest?: CreateWorkspaceReplicationSourceOfferFromManifest;
    createSourceOfferFromExportArtifacts?: CreateWorkspaceReplicationSourceOfferFromExportArtifacts;
    scanManifestIntoCas?: ScanWorkspaceManifestIntoCas;
    planMissingBlobs?: PlanWorkspaceReplicationMissingBlobs;
    applyPlan?: ApplyWorkspaceReplicationPlan;
}>;

export type WorkspaceReplicationCreateSourceOfferInput =
    Omit<Parameters<CreateWorkspaceReplicationSourceOffer>[0], 'activeServerDir'>;
export type WorkspaceReplicationCreateSourceOfferFromManifestInput =
    Omit<Parameters<CreateWorkspaceReplicationSourceOfferFromManifest>[0], 'activeServerDir'>;
export type WorkspaceReplicationCreateSourceOfferFromExportArtifactsInput =
    Omit<Parameters<CreateWorkspaceReplicationSourceOfferFromExportArtifacts>[0], 'activeServerDir'>;
export type WorkspaceReplicationScanManifestIntoCasInput =
    Omit<Parameters<ScanWorkspaceManifestIntoCas>[0], 'activeServerDir'>;
export type WorkspaceReplicationPlanMissingBlobsInput =
    Omit<Parameters<PlanWorkspaceReplicationMissingBlobs>[0], 'activeServerDir'>;
export type WorkspaceReplicationApplyPlanInput =
    Omit<Parameters<ApplyWorkspaceReplicationPlan>[0], 'activeServerDir'>;

export type WorkspaceReplicationEngineOperations = Readonly<{
    createSourceOffer: (
        input: WorkspaceReplicationCreateSourceOfferInput,
    ) => Promise<Awaited<ReturnType<CreateWorkspaceReplicationSourceOffer>>>;
    createSourceOfferFromManifest: (
        input: WorkspaceReplicationCreateSourceOfferFromManifestInput,
    ) => Promise<Awaited<ReturnType<CreateWorkspaceReplicationSourceOfferFromManifest>>>;
    createSourceOfferFromExportArtifacts: (
        input: WorkspaceReplicationCreateSourceOfferFromExportArtifactsInput,
    ) => Promise<Awaited<ReturnType<CreateWorkspaceReplicationSourceOfferFromExportArtifacts>>>;
    scanManifestIntoCas: (
        input: WorkspaceReplicationScanManifestIntoCasInput,
    ) => Promise<Awaited<ReturnType<ScanWorkspaceManifestIntoCas>>>;
    planMissingBlobs: (
        input: WorkspaceReplicationPlanMissingBlobsInput,
    ) => Promise<Awaited<ReturnType<PlanWorkspaceReplicationMissingBlobs>>>;
    applyPlan: (
        input: WorkspaceReplicationApplyPlanInput,
    ) => Promise<Awaited<ReturnType<ApplyWorkspaceReplicationPlan>>>;
}>;

export type WorkspaceReplicationEngine = Readonly<{
    activeServerDir: string;
    stores: WorkspaceReplicationEngineStores;
    transfers: WorkspaceReplicationTransfers;
    operations: WorkspaceReplicationEngineOperations;
}>;
