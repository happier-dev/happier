import { normalizeSessionHandoffWorkspaceRootPath } from '@happier-dev/protocol/sessions/control/handoff/workspaceTransferSourcePathSafety';
import { resolveWorkspaceSyncEndpoint, resolveWorkspaceSyncTransferRoute,
  type WorkspaceSyncChildMachineFacts } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { HandoffWorkspaceActionV1, WorkspaceRefV1, WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';

import { resolveWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { validateWorkspaceSyncRelationship } from '@/workspaces/sync/workspaceSyncSettings';

export type SessionHandoffWorkspaceContext = Readonly<{
  sourceWorkspaceRefId: string;
  targetWorkspaceRefId: string;
  sourceRootPath: string;
  targetRootPath: string;
  controllerMachineId: string;
  contentSelection?: 'git_worktree' | 'all_files';
  relationshipIds: readonly string[];
  contentSelections: readonly ('git_worktree' | 'all_files')[];
}>;

/**
 * Resolves an existing relationship's handoff endpoints. `copy_once` and
 * `create_relationship` materialize their `WorkspaceRef` values inside the
 * daemon relationship owner instead, so no caller-supplied endpoint identity is
 * representable here.
 */
export type ResolveSessionHandoffWorkspaceContextInput = Readonly<{
  serverId: string;
  action: Extract<HandoffWorkspaceActionV1, Readonly<{ kind: 'relationship' | 'linked_workspace' }>>;
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
  sourceMachineId: string;
  sourceRootPath?: string;
  targetMachineId: string;
  targetRootPath?: string;
}>;

function contextError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function exactRefByScope(
  refs: readonly WorkspaceRefV1[],
  serverId: string,
  machineId: string,
  rootPath: string,
): WorkspaceRefV1 | null {
  return resolveWorkspaceRefForMachineRoot(refs, { serverId, machineId, rootPath });
}

function normalizedRoot(value: unknown): string {
  return normalizeSessionHandoffWorkspaceRootPath(value)
    ?? (() => { throw contextError('workspace_root_unsafe', 'Workspace sync root is unsafe'); })();
}

export function resolveSessionHandoffWorkspaceContext(
  input: ResolveSessionHandoffWorkspaceContextInput,
): SessionHandoffWorkspaceContext {
  const action = input.action;
  const serverId = input.serverId.trim();
  const sourceMachineId = input.sourceMachineId.trim();
  const targetMachineId = input.targetMachineId.trim();
  const sourceRootPath = normalizedRoot(input.sourceRootPath);
  if (!serverId || !sourceMachineId || !targetMachineId) {
    throw contextError('workspace_ref_not_ready', 'Workspace sync machine identity is unavailable');
  }

  const workspaceRefs = input.workspaceRefs.filter((ref) => ref.serverId.trim() === serverId);
  const sourceByScope = exactRefByScope(workspaceRefs, serverId, sourceMachineId, sourceRootPath);
  if (!sourceByScope) throw contextError('relationship_source_mismatch', 'Source workspace is not uniquely identified');
  const sourceEndpoint = resolveWorkspaceSyncEndpoint({ workspace: sourceByScope, workspaceRefs, childMachines: input.childMachines });
  if (!sourceEndpoint.ok) throw contextError(sourceEndpoint.code, 'Child workspace Sync endpoint is unavailable');
  const requestedTargetRoot = input.targetRootPath === undefined ? null : normalizedRoot(input.targetRootPath);
  const requestedTarget = requestedTargetRoot === null
    ? null
    : exactRefByScope(workspaceRefs, serverId, targetMachineId, requestedTargetRoot);
  const targetCandidates = requestedTargetRoot === null
    ? workspaceRefs.filter((ref) => ref.machineId.trim() === targetMachineId)
    : requestedTarget ? [requestedTarget] : [];
  const relationships = input.relationships.map(validateWorkspaceSyncRelationship);
  const routeCandidates = targetCandidates.flatMap((target) => {
    const route = resolveWorkspaceSyncTransferRoute({
      serverId,
      workspaceRefs,
      relationships,
      childMachines: input.childMachines,
      sourceWorkspaceRefId: sourceByScope.id,
      targetWorkspaceRefId: target.id,
    });
    if (!route.ok) {
      if (route.code === 'workspace_sync_child_unavailable') throw contextError(route.code, 'Child workspace Sync endpoint is unavailable');
      return [];
    }
    if (action.kind === 'relationship' && (
      route.kind !== 'direct'
      || route.relationships[0]?.relationshipId !== action.relationshipId.trim()
    )) return [];
    return [{ target, route }];
  });
  if (routeCandidates.length !== 1) {
    throw contextError('relationship_target_mismatch', 'Target workspace is not uniquely reachable through the selected links');
  }
  const { target, route } = routeCandidates[0]!;
  const targetRootPath = normalizedRoot(target.rootPath);
  return {
    sourceWorkspaceRefId: sourceByScope.id,
    targetWorkspaceRefId: target.id,
    sourceRootPath: sourceByScope.rootPath,
    targetRootPath,
    controllerMachineId: route.kind === 'same_workspace' ? sourceEndpoint.endpoint.machineId : route.controllerMachineId,
    ...(route.relationships[0] ? { contentSelection: route.relationships[0].contentPolicy.selection } : {}),
    relationshipIds: route.relationships.map(({ relationshipId }) => relationshipId),
    contentSelections: route.relationships.map(({ contentPolicy }) => contentPolicy.selection),
  };
}
