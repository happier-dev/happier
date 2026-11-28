import { computeWorkspaceSyncPolicyDigest as computeCanonicalWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceSyncConflictResolutionResultV1, WorkspaceSyncConflictResolutionV1, ReadWorkspaceSyncFileResultV1, ReadWorkspaceSyncFileV1, WorkspaceContentPolicyV1, WorkspaceSyncConflictPageRequestV1, WorkspaceSyncConflictPageV1, WorkspaceSyncConflictInspectRpcRequestV1, WorkspaceSyncConflictInspectRpcResultV1, WorkspaceSyncCopyOnceV1, WorkspaceSyncRelationshipV1, WorkspaceSyncRelationshipsListRpcRequestV1, WorkspaceSyncRelationshipsListRpcResultV1, WorkspaceSyncStatusV1, HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol';
import type { WorkspaceRootOwnershipHandle } from './workspaceSyncRootOwnership';
import type { ManagedWorkspaceRefV2, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { MachineInstallationPublicIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { WorkspaceSyncStatusWatchRequestV1, WorkspaceSyncStatusWatchResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

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
  replaceRelationshipId?: string;
  targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
  targetReplacementApprovalReceiptId?: string;
  targetReplacementApprovalActionInput?: unknown;
  /** Present only for an admitted requester's remote TARGET; its prepare takes the signed path. */
  requesterTarget?: WorkspaceSyncRequesterTarget;
}>;

/**
 * An admitted requester's signed writer → target path for one relationship bootstrap,
 * qualified by one TARGET preflight. In-process only, never serialized; it lives as long
 * as the creation transaction that acquired it.
 */
export type WorkspaceSyncRequesterTarget = Readonly<{
  /** The admitted ingress context the prepare carries. */
  context: RpcHandlerContext;
  admittedTarget: Readonly<{ machineId: string; rootPath: string; targetManaged?: Pick<ManagedWorkspaceRefV2, 'managedId' | 'controller'> }>;
  /** Home-proven TARGET installation; both releases address it. */
  physicalEndpoint: MachineInstallationPublicIdentityV1;
  /** The installed SOURCE writer's release context for that endpoint. */
  cleanupContext: RpcHandlerContext;
}>;

/** Exact requester-admitted finite effect, including its physical endpoint selection. */
export type WorkspaceSyncFlushExpectation = Readonly<{
  relationship: WorkspaceSyncRelationshipV1;
  workspaceRefs: readonly WorkspaceRefV1[];
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
  watchStatuses(request: WorkspaceSyncStatusWatchRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusWatchResultV1>;
  subscribe(relationshipId: string, signal: AbortSignal): AsyncIterable<WorkspaceSyncStatusV1>;
  ensure(definition: WorkspaceSyncRelationshipV1, signal?: AbortSignal, preparation?: WorkspaceSyncRelationshipPreparation): Promise<WorkspaceSyncStatusV1>;
  copyOnce(input: WorkspaceSyncCopyOnceV1, signal?: AbortSignal, ownershipHandles?: readonly WorkspaceRootOwnershipHandle[]): Promise<WorkspaceSyncStatusV1>;
  flush(relationshipId: string, signal?: AbortSignal, expected?: WorkspaceSyncFlushExpectation): Promise<WorkspaceSyncStatusV1>;
  pause(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  resume(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  terminate(relationshipId: string, signal?: AbortSignal): Promise<void>;
  listConflicts(request: WorkspaceSyncConflictPageRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncConflictPageV1>;
  listRelationships(request: WorkspaceSyncRelationshipsListRpcRequestV1, signal?: AbortSignal, admittedRelationshipIds?: ReadonlySet<string>, admittedDefinitions?: readonly WorkspaceSyncRelationshipV1[] | null): Promise<WorkspaceSyncRelationshipsListRpcResultV1>;
  inspectConflict(request: WorkspaceSyncConflictInspectRpcRequestV1, signal?: AbortSignal, admittedRelationshipIds?: ReadonlySet<string>): Promise<WorkspaceSyncConflictInspectRpcResultV1>;
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
