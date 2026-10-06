import { areWorkspaceSyncRelationshipDefinitionsEqual } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { resolveWorkspaceSyncTransferRoute } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { WorkspaceRefV1, WorkspaceSyncPrepareBetweenResultV1, WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import type { WorkspaceSyncStatusV1 } from './workspaceSyncTypes';

export function isWorkspaceSyncStatusClean(status: WorkspaceSyncStatusV1): boolean {
  const { alpha, beta } = status.endpointStates;
  return alpha !== null
    && beta !== null
    && alpha.connected
    && beta.connected
    && alpha.scanned
    && beta.scanned
    && alpha.scanProblemCount === 0
    && beta.scanProblemCount === 0
    && alpha.transitionProblemCount === 0
    && beta.transitionProblemCount === 0
    && status.conflictCount === 0
    && status.state !== 'paused'
    && status.state !== 'disconnected'
    && status.state !== 'conflicted'
    && status.state !== 'controller_unavailable'
    && status.state !== 'error'
    && status.state !== 'stopped';
}

export function assertWorkspaceSyncStatusClean(status: WorkspaceSyncStatusV1): WorkspaceSyncStatusV1 {
  if (!isWorkspaceSyncStatusClean(status)) {
    throw Object.assign(new Error('Workspace synchronization did not complete cleanly'), {
      code: 'workspace_sync_not_clean',
      status,
    });
  }
  return status;
}

export async function prepareWorkspaceSyncRelationship(
  sync: Readonly<{ flush(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> }>,
  relationshipId: string,
  signal?: AbortSignal,
): Promise<WorkspaceSyncStatusV1> {
  return assertWorkspaceSyncStatusClean(await sync.flush(relationshipId, signal));
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : fallback;
}

/** Ordered, ephemeral pair/star barrier. Current settings are re-read before
 * every effect; no route cursor or successful-link rollback is created. */
export async function prepareWorkspaceSyncBetween(input: Readonly<{
  sourceWorkspaceRefId: string;
  targetWorkspaceRefId: string;
  readCurrent(): Promise<Readonly<{
    workspaceRefs: readonly WorkspaceRefV1[];
    relationships: readonly WorkspaceSyncRelationshipV1[];
  }>>;
  flush(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  signal?: AbortSignal;
}>): Promise<WorkspaceSyncPrepareBetweenResultV1> {
  const initial = await input.readCurrent();
  const route = resolveWorkspaceSyncTransferRoute({
    ...initial,
    sourceWorkspaceRefId: input.sourceWorkspaceRefId,
    targetWorkspaceRefId: input.targetWorkspaceRefId,
  });
  if (!route.ok) return { ok: false, errorCode: route.code, completed: [], ...('relationshipId' in route ? { blockedRelationshipId: route.relationshipId } : {}) };
  if (route.kind === 'same_workspace') return { ok: true, traversed: [] };

  const completed: Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: true }>['traversed'][number][] = [];
  for (const relationship of route.relationships) {
    input.signal?.throwIfAborted();
    const current = await input.readCurrent();
    const currentRoute = resolveWorkspaceSyncTransferRoute({
      ...current,
      sourceWorkspaceRefId: input.sourceWorkspaceRefId,
      targetWorkspaceRefId: input.targetWorkspaceRefId,
    });
    const currentRelationship = currentRoute.ok && currentRoute.kind !== 'same_workspace'
      ? currentRoute.relationships.find((candidate) => candidate.relationshipId === relationship.relationshipId)
      : undefined;
    if (!currentRelationship || !areWorkspaceSyncRelationshipDefinitionsEqual(currentRelationship, relationship)) {
      return {
        ok: false,
        errorCode: 'relationship_changed',
        completed,
        blockedRelationshipId: relationship.relationshipId,
      };
    }
    try {
      const status = await input.flush(relationship.relationshipId, input.signal);
      assertWorkspaceSyncStatusClean(status);
      completed.push({
        relationshipId: relationship.relationshipId,
        policyDigest: relationship.contentPolicy.policyDigest,
        status,
      });
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error
        ? error.status as WorkspaceSyncStatusV1
        : undefined;
      return {
        ok: false,
        errorCode: errorCode(error, 'workspace_sync_prepare_failed'),
        completed,
        blockedRelationshipId: relationship.relationshipId,
        ...(status ? { blockedStatus: status } : {}),
      };
    }
  }
  return { ok: true, traversed: completed };
}
