import { normalizeSessionHandoffWorkspaceRootPath } from '@happier-dev/protocol/sessions/control/handoff/workspaceTransferSourcePathSafety';
import { resolveWorkspaceSyncTransferRoute } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { HandoffWorkspaceActionV1, WorkspaceRefV1, WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';

import { resolveWorkspaceRefForMachineRoot } from '@/settings/accountSettings/workspaceRefsV1';
import { validateWorkspaceSyncRelationship } from '@/workspaces/sync/workspaceSyncSettings';

export type SessionHandoffWorkspaceContext = Readonly<{
  sourceWorkspaceRefId: string;
  targetWorkspaceRefId: string;
  sourceRootPath: string;
  targetRootPath: string;
  controllerMachineId: string;
  contentSelection: 'git_worktree' | 'all_files';
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
  action: Extract<HandoffWorkspaceActionV1, Readonly<{ kind: 'relationship' | 'linked_workspace' }>>;
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
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
  machineId: string,
  rootPath: string,
): WorkspaceRefV1 | null {
  return resolveWorkspaceRefForMachineRoot(refs, { machineId, rootPath });
}

function normalizedRoot(value: unknown): string {
  return normalizeSessionHandoffWorkspaceRootPath(value)
    ?? (() => { throw contextError('workspace_root_unsafe', 'Workspace sync root is unsafe'); })();
}

export function resolveSessionHandoffWorkspaceContext(
  input: ResolveSessionHandoffWorkspaceContextInput,
): SessionHandoffWorkspaceContext {
  const action = input.action;
  const sourceMachineId = input.sourceMachineId.trim();
  const targetMachineId = input.targetMachineId.trim();
  const sourceRootPath = normalizedRoot(input.sourceRootPath);
  if (!sourceMachineId || !targetMachineId) {
    throw contextError('workspace_ref_not_ready', 'Workspace sync machine identity is unavailable');
  }

  const sourceByScope = exactRefByScope(input.workspaceRefs, sourceMachineId, sourceRootPath);
  if (!sourceByScope) throw contextError('relationship_source_mismatch', 'Source workspace is not uniquely identified');
  const requestedTargetRoot = input.targetRootPath === undefined ? null : normalizedRoot(input.targetRootPath);
  const targetCandidates = input.workspaceRefs.filter((ref) => (
    ref.machineId.trim() === targetMachineId
    && (requestedTargetRoot === null || normalizedRoot(ref.rootPath) === requestedTargetRoot)
  ));
  const relationships = input.relationships.map(validateWorkspaceSyncRelationship);
  const routeCandidates = targetCandidates.flatMap((target) => {
    const route = resolveWorkspaceSyncTransferRoute({
      workspaceRefs: input.workspaceRefs,
      relationships,
      sourceWorkspaceRefId: sourceByScope.id,
      targetWorkspaceRefId: target.id,
    });
    if (!route.ok || route.kind === 'same_workspace') return [];
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
  if (requestedTargetRoot !== null) {
    const requestedTarget = exactRefByScope(input.workspaceRefs, targetMachineId, requestedTargetRoot);
    if (!requestedTarget || requestedTarget.id !== target.id) {
      throw contextError('relationship_target_mismatch', 'Target path is not the opposite relationship endpoint');
    }
  }
  return {
    sourceWorkspaceRefId: sourceByScope.id,
    targetWorkspaceRefId: target.id,
    sourceRootPath: sourceByScope.rootPath,
    targetRootPath,
    controllerMachineId: route.controllerMachineId,
    contentSelection: route.relationships[0]!.contentPolicy.selection,
    relationshipIds: route.relationships.map(({ relationshipId }) => relationshipId),
    contentSelections: route.relationships.map(({ contentPolicy }) => contentPolicy.selection),
  };
}
