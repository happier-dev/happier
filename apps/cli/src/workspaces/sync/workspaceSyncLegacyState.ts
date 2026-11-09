import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceSyncLegacyStateInspectionV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

export type WorkspaceSyncLegacyStateInspection = Extract<
  WorkspaceSyncLegacyStateInspectionV1,
  { status: 'absent' | 'preserved' }
>;

/**
 * Explicit diagnostic only. Old state belongs to 0.2 and stays at its original
 * path for downgrade; neither startup nor sync admission consumes this result.
 * lstat deliberately does not traverse a symlink or read predecessor contents.
 */
export async function inspectRetiredWorkspaceReplicationState(
  input: Readonly<{ activeServerDir: string }>,
): Promise<WorkspaceSyncLegacyStateInspection> {
  const path = join(input.activeServerDir, 'workspace-replication');
  try {
    await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { status: 'absent' };
    }
    throw error;
  }
  return { status: 'preserved', path };
}
