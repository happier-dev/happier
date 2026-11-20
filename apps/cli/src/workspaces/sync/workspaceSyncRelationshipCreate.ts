import { WorkspaceSyncRelationshipCreateResultV1Schema, WorkspaceSyncRelationshipCreateRpcRequestV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceRefV1, WorkspaceSyncRelationshipCreateResultV1, WorkspaceSyncRelationshipCreateRpcRequestV1 } from '@happier-dev/protocol';
import { resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { isManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import type { WorkspaceSyncRelationshipOwner } from './workspaceSyncRelationshipOwner';

/**
 * Direct Project linking: "Add machine" on a selected Workspace.
 *
 * This is the second consumer of the one relationship writer, beside session
 * handoff. It deliberately owns no settings transaction, operation store or
 * bootstrap of its own: it resolves the selected source Workspace against the
 * daemon's current Account settings and then runs the existing
 * `prepareCreate` → `commit` transaction.
 *
 * Unlike handoff, there is no Session to quiesce and nothing downstream waiting
 * on a clean workspace, so the committed engine status is returned as observed.
 * Conflicts from attaching a divergent existing checkout are a successful link
 * that needs attention, not a failed creation.
 */
export type WorkspaceSyncRelationshipCreateDependencies = Readonly<{
  localServerId: string;
  localMachineId: string;
  /** Current Account settings WorkspaceRef lookup; never a caller-supplied root. */
  resolveWorkspaceRef(workspaceRefId: string): WorkspaceRefV1 | null;
  relationshipOwner: Pick<WorkspaceSyncRelationshipOwner, 'prepareCreate'>;
  /** Native checkout admission may already have reserved the exact target ref. */
  targetWorkspaceRefId?: string;
}>;

function createError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export async function createWorkspaceSyncRelationshipForProject(
  dependencies: WorkspaceSyncRelationshipCreateDependencies,
  rawRequest: unknown,
  signal?: AbortSignal,
): Promise<WorkspaceSyncRelationshipCreateResultV1> {
  signal?.throwIfAborted();
  const request: WorkspaceSyncRelationshipCreateRpcRequestV1 =
    WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(rawRequest);
  const input = request.actionInput;

  const source = dependencies.resolveWorkspaceRef(input.sourceWorkspaceRefId);
  if (!source) {
    throw createError('workspace_ref_not_ready', 'The selected workspace is not available in current settings');
  }
  if (source.serverId.trim() !== dependencies.localServerId.trim()) {
    throw createError('workspace_ref_not_ready', 'The selected workspace belongs to another Account Home');
  }
  // Creation runs on the source controller. A rebound or stale selection is
  // refused here, before any file is read, rather than silently retargeted.
  const sourceMachineId = resolveWorkspaceSyncExecutionMachineIdV1(source).trim();
  if (sourceMachineId !== dependencies.localMachineId.trim()) {
    throw createError(
      'workspace_sync_controller_mismatch',
      'Workspace linking must run on the machine that hosts the selected workspace',
    );
  }
  if (!source.rootPath.trim()) {
    throw createError('workspace_root_unsafe', 'The selected workspace has no root path');
  }

  const prepared = await dependencies.relationshipOwner.prepareCreate({
    operationId: request.operationId,
    ...('replaceRelationshipId' in input ? { replaceRelationshipId: input.replaceRelationshipId } : {}),
    serverId: source.serverId.trim(),
    sourceMachineId,
    ...(isManagedWorkspaceRefV2(source) ? { sourceAddress: workspaceAddressFromRefV2(source) } : {}),
    sourceRootPath: source.rootPath,
    sourceWorkspaceRefId: input.sourceWorkspaceRefId,
    ...(dependencies.targetWorkspaceRefId ? { targetWorkspaceRefId: dependencies.targetWorkspaceRefId } : {}),
    targetMachineId: input.targetMachineId,
    targetRootPath: input.targetPath,
    mode: input.mode,
    contentPolicy: input.contentPolicy,
    targetBootstrap: input.destinationIntent,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(request.targetReplacementApproval
      ? {
          targetReplacementApproval: request.targetReplacementApproval,
          ...(request.targetReplacementApprovalReceiptId
            ? { targetReplacementApprovalReceiptId: request.targetReplacementApprovalReceiptId }
            : {}),
          // The admitted Action input is the exact approved input; there is no
          // second copy of it to keep in step with the artifact.
          targetReplacementApprovalActionInput: input,
        }
      : {}),
    flushBeforeCommit: true,
    ...(signal ? { signal } : {}),
  });

  let committed: Awaited<ReturnType<typeof prepared.commit>>;
  try {
    signal?.throwIfAborted();
    committed = await prepared.commit();
  } catch (error) {
    // `commit` already settles its own runtime for a determinate failure and
    // closes the transaction, so this is the cancellation/abort path. It never
    // deletes an attached existing folder: only materialization custody rolls
    // back, and `use_existing` creates none.
    await prepared.abort().catch(() => undefined);
    throw error;
  }

  const targetWorkspaceRefId = committed.alphaWorkspaceRefId === input.sourceWorkspaceRefId
    ? committed.betaWorkspaceRefId
    : committed.alphaWorkspaceRefId;

  return WorkspaceSyncRelationshipCreateResultV1Schema.parse({
    v: 1,
    relationshipId: committed.relationshipId,
    created: !prepared.reused,
    controllerMachineId: committed.controllerMachineId,
    sourceWorkspaceRefId: input.sourceWorkspaceRefId,
    targetWorkspaceRefId,
    status: prepared.status,
  });
}
