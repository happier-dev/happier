import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { ScmBackendRegistry } from '@/scm/registry';
import type { WorkspaceManifestSafeFilterPolicy } from '@/scm/sourceController/workspaceExportPackaging/workspaceManifestSafeFilterPolicy';
import type {
    ScmSourceControllerWorkspaceTransferConflictPolicy,
    ScmSourceControllerWorkspaceTransferStrategy,
} from '@/scm/sourceController/workspaceTransfer';

import type { WorkspaceReplicationBaselineRecord } from './baseline/workspaceReplicationBaselineStore';
import type { WorkspaceReplicationJobRecord } from './jobs/workspaceReplicationJobStore';
import type { WorkspaceReplicationDirectionScope } from './relationships/relationshipScope';
import type { WorkspaceReplicationSourceOffer } from './transport/createWorkspaceReplicationSourceOffer';

export type WorkspaceReplicationEngineInput = Readonly<{
    activeServerDir: string;
    localMachineId: string;
    scmRegistry?: ScmBackendRegistry;
    now?: () => number;
}>;

type CreateWorkspaceReplicationBaselineStore = typeof import('./baseline/workspaceReplicationBaselineStore').createWorkspaceReplicationBaselineStore;
type CreateWorkspaceReplicationCasStore = typeof import('./cas/workspaceReplicationCasStore').createWorkspaceReplicationCasStore;
type CreateWorkspaceReplicationJobStore = typeof import('./jobs/workspaceReplicationJobStore').createWorkspaceReplicationJobStore;
type CreateWorkspaceReplicationRelationshipStore =
    typeof import('./relationships/workspaceReplicationRelationshipStore').createWorkspaceReplicationRelationshipStore;

type CreateWorkspaceReplicationSourceOffer =
    typeof import('./transport/createWorkspaceReplicationSourceOffer').createWorkspaceReplicationSourceOffer;

type ScanWorkspaceManifestIntoCas = typeof import('./scan/scanWorkspaceManifestIntoCas').scanWorkspaceManifestIntoCas;

type ExecuteWorkspaceReplicationJobWithLocalRuntime =
    typeof import('./orchestration/executeWorkspaceReplicationJobWithLocalRuntime').executeWorkspaceReplicationJobWithLocalRuntime;

type CreateWorkspaceReplicationSourceOfferStore =
    typeof import('./transport/workspaceReplicationSourceOfferStore').createWorkspaceReplicationSourceOfferStore;

export type WorkspaceReplicationEngineDependencies = Readonly<{
    createCasStore?: CreateWorkspaceReplicationCasStore;
    createRelationshipStore?: CreateWorkspaceReplicationRelationshipStore;
    createBaselineStore?: CreateWorkspaceReplicationBaselineStore;
    createJobStore?: CreateWorkspaceReplicationJobStore;
    createSourceOfferStore?: CreateWorkspaceReplicationSourceOfferStore;
    createSourceOffer?: CreateWorkspaceReplicationSourceOffer;
    scanManifestIntoCas?: ScanWorkspaceManifestIntoCas;
    executeJobWithLocalRuntime?: ExecuteWorkspaceReplicationJobWithLocalRuntime;
    executeJobInBackground?: (input: WorkspaceReplicationJobExecutionInput) => void;
}>;

export type WorkspaceReplicationResolvedRelationship = Readonly<{
    relationshipId: string;
    directionId: string;
    baseline: WorkspaceReplicationBaselineRecord | null;
}>;

export type WorkspaceReplicationPreflightSummary = Readonly<{
    plannedFileCount: number;
    plannedByteCount: number;
    removedFileCount: number;
    removedByteCount: number;
}>;

export type WorkspaceReplicationPlanResult = Readonly<{
    scope: WorkspaceReplicationDirectionScope;
    baseline: WorkspaceReplicationBaselineRecord | null;
    sourceManifest: WorkspaceManifest;
    targetManifest: WorkspaceManifest;
    preflightSummary: WorkspaceReplicationPreflightSummary;
    // Present only when mode === 'one_way_safe' and baseline exists.
    blockingTargetDivergencePaths?: readonly string[];
    targetDivergencePaths?: readonly string[];
    canApplySafely?: boolean;
}>;

export type WorkspaceReplicationCreateSourceOfferInput = Readonly<{
    scope: WorkspaceReplicationDirectionScope;
    safeFilterPolicy?: WorkspaceManifestSafeFilterPolicy;
}>;

export type WorkspaceReplicationApplyInput = Readonly<{
    targetPath: string;
    strategy: ScmSourceControllerWorkspaceTransferStrategy;
    conflictPolicy: ScmSourceControllerWorkspaceTransferConflictPolicy;
    registry?: ScmBackendRegistry;
}>;

export type WorkspaceReplicationBlobPackRequestToFile = (input: Readonly<{
    packId: string;
    digests: readonly string[];
    destinationPath: string;
}>) => Promise<void>;

export type WorkspaceReplicationStartJobFromOfferInput = Readonly<{
    scope: WorkspaceReplicationDirectionScope;
    sourceOffer: WorkspaceReplicationSourceOffer;
    apply: WorkspaceReplicationApplyInput;
    requestBlobPackToFile: WorkspaceReplicationBlobPackRequestToFile;
    correlationId?: string;
}>;

export type WorkspaceReplicationStartJobFromOfferResult = Readonly<{
    jobId: string;
    initialStatus: WorkspaceReplicationJobRecord;
}>;

export type WorkspaceReplicationListJobsInput = Readonly<{
    correlationId?: string;
    limit?: number;
}>;

export type WorkspaceReplicationGcInput = Readonly<{
    nowMs?: number;
    terminalTtlMs: number;
    casUnreferencedTtlMs?: number;
    casMaxBytes?: number;
}>;

export type WorkspaceReplicationGcResult = Readonly<{
    jobs: Readonly<{ removedJobIds: string[] }>;
    cas?: Readonly<{
        skippedDueToActiveJobs: boolean;
        removedDigests: readonly string[];
    }>;
}>;

export type WorkspaceReplicationJobExecutionInput = Readonly<{
    jobId: string;
    scope: WorkspaceReplicationDirectionScope;
    sourceOffer: WorkspaceReplicationSourceOffer;
    apply: WorkspaceReplicationApplyInput;
    requestBlobPackToFile: WorkspaceReplicationBlobPackRequestToFile;
}>;
