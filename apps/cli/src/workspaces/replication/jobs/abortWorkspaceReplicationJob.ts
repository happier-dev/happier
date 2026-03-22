import type { WorkspaceReplicationJobRecord, WorkspaceReplicationJobStore } from './workspaceReplicationJobStore';

const TERMINAL_JOB_STATUSES = new Set<WorkspaceReplicationJobRecord['status']['status']>([
  'completed',
  'aborted',
  'failed',
  'awaiting_recovery',
]);

function isTerminalJobRecord(record: WorkspaceReplicationJobRecord): boolean {
  return TERMINAL_JOB_STATUSES.has(record.status.status);
}

export async function abortWorkspaceReplicationJob(params: Readonly<{
  jobStore: WorkspaceReplicationJobStore;
  jobId: string;
  now?: () => number;
}>): Promise<WorkspaceReplicationJobRecord | null> {
  const current = await params.jobStore.read(params.jobId);
  if (!current) {
    return null;
  }
  if (isTerminalJobRecord(current)) {
    return current;
  }

  const nowMs = params.now?.() ?? Date.now();
  const next: WorkspaceReplicationJobRecord = {
    ...current,
    updatedAtMs: nowMs,
    cancelRequestedAtMs: current.cancelRequestedAtMs ?? nowMs,
    abortedAtMs: nowMs,
    status: {
      ...current.status,
      status: 'aborted',
    },
  };

  await params.jobStore.write(next);
  return next;
}
