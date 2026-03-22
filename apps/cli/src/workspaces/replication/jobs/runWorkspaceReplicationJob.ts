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

function resolveJobFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Workspace replication job failed';
}

export async function runWorkspaceReplicationJob(params: Readonly<{
  jobStore: WorkspaceReplicationJobStore;
  jobId: string;
  now?: () => number;
  run: (current: WorkspaceReplicationJobRecord) => Promise<WorkspaceReplicationJobRecord>;
}>): Promise<WorkspaceReplicationJobRecord> {
  const current = await params.jobStore.read(params.jobId);
  if (!current) {
    throw new Error(`Workspace replication job not found: ${params.jobId}`);
  }
  if (isTerminalJobRecord(current)) {
    return current;
  }

  const nowMs = params.now?.() ?? Date.now();

  try {
    const next = await params.run(current);
    if (next.jobId !== current.jobId) {
      throw new Error(`Workspace replication job runner returned mismatched job id: ${next.jobId}`);
    }
    const persisted: WorkspaceReplicationJobRecord = {
      ...next,
      updatedAtMs: nowMs,
    };
    await params.jobStore.write(persisted);
    return persisted;
  } catch (error) {
    const failedRecord: WorkspaceReplicationJobRecord = {
      ...current,
      updatedAtMs: nowMs,
      failedAtMs: nowMs,
      lastErrorMessage: resolveJobFailureMessage(error),
      status: {
        ...current.status,
        status: 'failed',
      },
    };
    await params.jobStore.write(failedRecord);
    throw error;
  }
}
