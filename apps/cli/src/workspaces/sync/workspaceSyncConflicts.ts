import type { WorkspaceSyncConflictListV1 } from './workspaceSyncTypes';

export const MAX_WORKSPACE_SYNC_CONFLICTS = 100;
export function normalizeWorkspaceSyncConflictList(value: unknown, relationshipId: string): WorkspaceSyncConflictListV1 {
  if (!value || typeof value !== 'object') throw new Error('Invalid workspace sync conflict list');
  const input = value as Record<string, unknown>;
  if (input.relationshipId !== relationshipId || !Array.isArray(input.conflicts)) throw new Error('Invalid workspace sync conflict list');
  const totalCount = Number(input.totalCount); const conflicts = input.conflicts.slice(0, MAX_WORKSPACE_SYNC_CONFLICTS) as WorkspaceSyncConflictListV1['conflicts'];
  if (!Number.isSafeInteger(totalCount) || totalCount < conflicts.length) throw new Error('Invalid workspace sync conflict count');
  return { relationshipId, totalCount, shownCount: conflicts.length, truncatedCount: Math.max(0, totalCount - conflicts.length), conflicts };
}
