import type { WorkspaceReplicationJobRecord, WorkspaceReplicationJobStore } from './workspaceReplicationJobStore';
import { WorkspaceReplicationJobCancelRequestedError } from '../safety/workspaceReplicationJobCancelRequestedError';
import { WorkspaceReplicationError } from '../workspaceReplicationError';
import { isTerminalWorkspaceReplicationJobStatus } from './workspaceReplicationJobTerminalStatuses';

function isTerminalJobRecord(record: WorkspaceReplicationJobRecord): boolean {
  return isTerminalWorkspaceReplicationJobStatus(record.status.status);
}

function resolveJobFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Workspace replication job failed';
}

function isCancelRequestedError(error: unknown): error is WorkspaceReplicationJobCancelRequestedError {
  return error instanceof WorkspaceReplicationJobCancelRequestedError;
}

export async function runWorkspaceReplicationJob(params: Readonly<{
  jobStore: WorkspaceReplicationJobStore;
  jobId: string;
  now?: () => number;
  run: (current: WorkspaceReplicationJobRecord) => Promise<WorkspaceReplicationJobRecord>;
}>): Promise<WorkspaceReplicationJobRecord> {
  const current = await params.jobStore.read(params.jobId);
  if (!current) {
    throw new WorkspaceReplicationError({
      code: 'job_not_found',
      message: `Workspace replication job not found: ${params.jobId}`,
    });
  }
  if (isTerminalJobRecord(current)) {
    return current;
  }

  const nowMs = () => params.now?.() ?? Date.now();

  try {
    const next = await params.run(current);
    if (next.jobId !== current.jobId) {
      throw new Error(`Workspace replication job runner returned mismatched job id: ${next.jobId}`);
    }
    const persistedAtMs = nowMs();
    const persisted: WorkspaceReplicationJobRecord = {
      ...next,
      updatedAtMs: persistedAtMs,
    };
    await params.jobStore.write(persisted);
    // The store can merge/override fields (checkpoint regression guards, sticky cancellation, terminal guards).
    // Always return the canonical post-merge record so orchestration logic can't proceed with stale state.
    const merged = await params.jobStore.read(params.jobId);
    if (!merged) {
      throw new WorkspaceReplicationError({
        code: 'job_not_found',
        message: `Workspace replication job not found after write: ${params.jobId}`,
      });
    }
    return merged;
  } catch (error) {
    const failedAtMs = nowMs();
    if (isCancelRequestedError(error)) {
      const abortedRecord: WorkspaceReplicationJobRecord = {
        ...current,
        updatedAtMs: failedAtMs,
        cancelRequestedAtMs: current.cancelRequestedAtMs ?? failedAtMs,
        abortedAtMs: current.abortedAtMs ?? failedAtMs,
        status: {
          ...current.status,
          status: 'aborted',
        },
      };
      await params.jobStore.write(abortedRecord);
      throw error;
    }

    const failedRecord: WorkspaceReplicationJobRecord = {
      ...current,
      updatedAtMs: failedAtMs,
      failedAtMs: failedAtMs,
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
