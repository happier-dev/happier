import { computeWorkspaceSyncPolicyDigest as computeCanonicalWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceSyncConflictResolutionResultV1, WorkspaceSyncConflictResolutionV1, ReadWorkspaceSyncFileResultV1, ReadWorkspaceSyncFileV1, WorkspaceContentPolicyV1, WorkspaceSyncConflictPageRequestV1, WorkspaceSyncConflictPageV1, WorkspaceSyncConflictInspectRpcRequestV1, WorkspaceSyncConflictInspectRpcResultV1, WorkspaceSyncCopyOnceV1, WorkspaceSyncRelationshipV1, WorkspaceSyncRelationshipsListRpcRequestV1, WorkspaceSyncRelationshipsListRpcResultV1, WorkspaceSyncStatusV1, HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol';
import type { WorkspaceRootOwnershipHandle } from './workspaceSyncRootOwnership';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

export type {
  ReadWorkspaceSyncFileResultV1,
  ReadWorkspaceSyncFileV1,
  WorkspaceContentPolicyV1,
  WorkspaceSyncConflictListV1,
  WorkspaceSyncConflictPageRequestV1,
  WorkspaceSyncConflictPageV1,
  WorkspaceSyncConflictV1,
  WorkspaceSyncConflictInspectRpcRequestV1,
  WorkspaceSyncConflictInspectRpcResultV1,
  WorkspaceSyncCopyOnceV1,
  WorkspaceSyncModeV1,
  WorkspaceSyncPersistentModeV1,
  WorkspaceSyncRelationshipV1,
  WorkspaceSyncRelationshipsListRpcRequestV1,
  WorkspaceSyncRelationshipsListRpcResultV1,
  WorkspaceSyncStatusV1,
} from '@happier-dev/protocol';

export function computeWorkspaceSyncPolicyDigest(policy: Omit<WorkspaceContentPolicyV1, 'policyDigest'>): string {
  return computeCanonicalWorkspaceSyncPolicyDigest(policy);
}

export type WorkspaceSyncRelationshipPreparation = Readonly<{
  transient: true;
  targetBootstrap: 'use_existing' | 'materialize_from_source_workspace';
  targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
  targetReplacementApprovalReceiptId?: string;
  targetReplacementApprovalActionInput?: unknown;
}>;

/** A read-only participant in a root already fenced by a linked workspace. */
export type WorkspaceSyncSourceRootLoan = Readonly<{
  handle: WorkspaceRootOwnershipHandle;
  release(): Promise<void>;
}>;

/** Daemon-local lifecycle interface; wire shapes remain protocol-owned. */
export interface ManagedWorkspaceSync {
  /** Concrete lifecycle owners provide this; a missing applicable producer remains unknown. */
  readonly activity?: import('@/daemon/lifecycle/managedActivity').LiveWorkProducerV1;
  /** Daemon-local retained root authority for a reviewed entry effect. */
  resolveLocalResolutionEndpoint(relationshipId: string, workspaceRefId: string): Promise<Readonly<{
    /** Exact retained controller definition when proving initial recovery custody. */
    relationship?: WorkspaceSyncRelationshipV1;
    canonicalRoot: string;
    assertCurrentAuthority(): Promise<void>;
  }> | null>;
  borrowSourceRootForCopy(operationId: string, workspaceRefId: string): Promise<WorkspaceSyncSourceRootLoan | null>;
  get(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1 | null>;
  list(signal?: AbortSignal): Promise<readonly WorkspaceSyncStatusV1[]>;
  subscribe(relationshipId: string, signal: AbortSignal): AsyncIterable<WorkspaceSyncStatusV1>;
  ensure(definition: WorkspaceSyncRelationshipV1, signal?: AbortSignal, preparation?: WorkspaceSyncRelationshipPreparation): Promise<WorkspaceSyncStatusV1>;
  copyOnce(input: WorkspaceSyncCopyOnceV1, signal?: AbortSignal, ownershipHandles?: readonly WorkspaceRootOwnershipHandle[]): Promise<WorkspaceSyncStatusV1>;
  flush(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  pause(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  resume(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  terminate(relationshipId: string, signal?: AbortSignal): Promise<void>;
  listConflicts(request: WorkspaceSyncConflictPageRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncConflictPageV1>;
  listRelationships(request: WorkspaceSyncRelationshipsListRpcRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncRelationshipsListRpcResultV1>;
  inspectConflict(request: WorkspaceSyncConflictInspectRpcRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncConflictInspectRpcResultV1>;
  resolveConflict(
    request: WorkspaceSyncConflictResolutionV1,
    signal: AbortSignal | undefined,
    actionReceiptId: string,
  ): Promise<WorkspaceSyncConflictResolutionResultV1>;
  readFile(request: ReadWorkspaceSyncFileV1, signal?: AbortSignal): Promise<ReadWorkspaceSyncFileResultV1>;
  withAuthorizedSourceSeedExport<T>(
    request: Readonly<{
      operationId: string;
      sourceWorkspaceRefId: string;
      targetMachineId: string;
      contentPolicy: WorkspaceContentPolicyV1;
    }>,
    exportSource: (canonicalSourcePath: string) => Promise<T>,
  ): Promise<T>;
  withSourceSeedAuthorization<T>(
    operation: WorkspaceSyncRelationshipV1 | WorkspaceSyncCopyOnceV1,
    ownershipHandles: readonly WorkspaceRootOwnershipHandle[],
    action: () => Promise<T>,
    acceptedTargetWorkspace?: WorkspaceRefV1,
  ): Promise<T>;
}
