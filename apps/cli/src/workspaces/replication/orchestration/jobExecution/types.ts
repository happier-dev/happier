import type { WorkspaceReplicationJobRecord, WorkspaceReplicationJobStore } from '@/workspaces/replication/jobs/workspaceReplicationJobStore';
import type { WorkspaceReplicationRelationshipStore } from '@/workspaces/replication/relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationSourceOffer } from '@/workspaces/replication/transport/createWorkspaceReplicationSourceOffer';

export type ExecuteWorkspaceReplicationJobParams = Readonly<{
  activeServerDir: string;
  jobStore: WorkspaceReplicationJobStore;
  relationships: WorkspaceReplicationRelationshipStore;
  jobId: string;
  now?: () => number;
  resolveSourceOfferById: (offerId: string) => Promise<WorkspaceReplicationSourceOffer>;
  assertSafeToApply?: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
  }>) => Promise<
    | null
    | WorkspaceReplicationJobRecord
    | Readonly<{
      blockingDivergenceCandidates: readonly string[];
      lastErrorMessage?: string;
    }>
  >;
  transferMissingBlobsToTargetCas: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
    missingDigests: readonly string[];
    missingBytes: number;
  }>) => Promise<Readonly<{ transferredFiles: number; transferredBytes: number }>>;
  applyPlan: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
  }>) => Promise<Readonly<{ appliedFiles: number; appliedBytes: number; targetPath: string }>>;
  commitBaseline: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
  }>) => Promise<void>;
}>;
