import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  WorkspaceReplicationJobRecordSchema,
  type WorkspaceReplicationJobRecord,
  safeParseWorkspaceReplicationJobRecordFromDiskValue,
} from '../jobs/workspaceReplicationJobStore';
import {
  createWorkspaceReplicationPaths,
  resolveWorkspaceReplicationJobPath,
} from './workspaceReplicationPaths';

const TERMINAL_JOB_STATUSES = new Set<WorkspaceReplicationJobRecord['status']['status']>([
  'completed',
  'aborted',
  'failed',
  'awaiting_recovery',
]);

function resolveTerminalAtMs(record: WorkspaceReplicationJobRecord): number | null {
  if (typeof record.completedAtMs === 'number') return record.completedAtMs;
  if (typeof record.abortedAtMs === 'number') return record.abortedAtMs;
  if (typeof record.failedAtMs === 'number') return record.failedAtMs;
  return null;
}

async function readJobRecord(filePath: string): Promise<WorkspaceReplicationJobRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    // Use the job store's normalization so legacy persisted job records are GC'd correctly.
    return safeParseWorkspaceReplicationJobRecordFromDiskValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function gcWorkspaceReplicationJobs(params: Readonly<{
  activeServerDir: string;
  nowMs: number;
  terminalTtlMs: number;
}>): Promise<Readonly<{ removedJobIds: string[] }>> {
  const paths = createWorkspaceReplicationPaths({
    activeServerDir: params.activeServerDir,
  });

  const removedJobIds: string[] = [];
  try {
    const entries = await readdir(paths.jobsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = join(paths.jobsDirectory, entry.name);
      const record = await readJobRecord(filePath);
      if (!record) {
        continue;
      }
      if (!TERMINAL_JOB_STATUSES.has(record.status.status)) {
        continue;
      }
      const terminalAtMs = resolveTerminalAtMs(record) ?? record.updatedAtMs;
      if (params.nowMs - terminalAtMs <= params.terminalTtlMs) {
        continue;
      }
      await unlink(resolveWorkspaceReplicationJobPath({
        jobsDirectory: paths.jobsDirectory,
        jobId: record.jobId,
      })).catch(() => undefined);
      removedJobIds.push(record.jobId);
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code !== 'ENOENT') {
      throw error;
    }
  }

  return { removedJobIds };
}
