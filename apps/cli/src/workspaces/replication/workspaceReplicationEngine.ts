import type { WorkspaceReplicationJobRecord } from './jobs/workspaceReplicationJobStore';
import type { WorkspaceReplicationDirectionScope } from './relationships/relationshipScope';
import type { WorkspaceReplicationSourceOffer } from './transport/createWorkspaceReplicationSourceOffer';

import type {
    WorkspaceReplicationCreateSourceOfferInput,
    WorkspaceReplicationGcInput,
    WorkspaceReplicationGcResult,
    WorkspaceReplicationListJobsInput,
    WorkspaceReplicationPlanResult,
    WorkspaceReplicationResolvedRelationship,
    WorkspaceReplicationStartJobFromOfferInput,
    WorkspaceReplicationStartJobFromOfferResult,
} from './workspaceReplicationTypes';

export type WorkspaceReplicationEngine = Readonly<{
    activeServerDir: string;
    localMachineId: string;

    resolveRelationship: (scope: WorkspaceReplicationDirectionScope) => Promise<WorkspaceReplicationResolvedRelationship>;

    plan: (input: Readonly<{
        scope: WorkspaceReplicationDirectionScope;
        sourceManifest: WorkspaceReplicationPlanResult['sourceManifest'];
        targetWorkspaceRoot: string;
    }>) => Promise<WorkspaceReplicationPlanResult>;

    createSourceOffer: (
        input: WorkspaceReplicationCreateSourceOfferInput | WorkspaceReplicationDirectionScope,
    ) => Promise<WorkspaceReplicationSourceOffer>;

    startJobFromOffer: (input: WorkspaceReplicationStartJobFromOfferInput) => Promise<WorkspaceReplicationStartJobFromOfferResult>;

    getJobStatus: (jobId: string) => Promise<WorkspaceReplicationJobRecord>;
    listJobs: (input?: WorkspaceReplicationListJobsInput) => Promise<readonly WorkspaceReplicationJobRecord[]>;
    abortJob: (jobId: string) => Promise<WorkspaceReplicationJobRecord>;

    gc: (input: WorkspaceReplicationGcInput) => Promise<WorkspaceReplicationGcResult>;
}>;
