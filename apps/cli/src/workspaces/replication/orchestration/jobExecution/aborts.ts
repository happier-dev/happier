import { runWorkspaceReplicationJob } from '@/workspaces/replication/jobs/runWorkspaceReplicationJob';
import type { WorkspaceReplicationJobRecord } from '@/workspaces/replication/jobs/workspaceReplicationJobStore';
import { WorkspaceReplicationError } from '@/workspaces/replication/workspaceReplicationError';
import { WorkspaceReplicationJobCancelRequestedError } from '@/workspaces/replication/safety/workspaceReplicationJobCancelRequestedError';
import { removeWorkspaceReplicationJobStagingDirectory } from '@/workspaces/replication/state/workspaceReplicationJobLease';

import type { ExecuteWorkspaceReplicationJobParams } from './types';

export function resolveNowMs(now?: () => number): number {
  return now?.() ?? Date.now();
}

export function abortRecord(current: WorkspaceReplicationJobRecord, nowMs: number): WorkspaceReplicationJobRecord {
  return {
    ...current,
    cancelRequestedAtMs: current.cancelRequestedAtMs ?? nowMs,
    abortedAtMs: current.abortedAtMs ?? nowMs,
    status: {
      ...current.status,
      status: 'aborted',
    },
  };
}

export function isCancelRequestedError(error: unknown): error is WorkspaceReplicationJobCancelRequestedError {
  return error instanceof WorkspaceReplicationJobCancelRequestedError;
}

export async function abortJobAndReturn(
  params: Pick<ExecuteWorkspaceReplicationJobParams, 'activeServerDir' | 'jobStore' | 'jobId' | 'now'>,
): Promise<WorkspaceReplicationJobRecord> {
  const nowMs = resolveNowMs(params.now);
  const record = await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (current) => abortRecord(current, nowMs),
  });
  await removeWorkspaceReplicationJobStagingDirectory({
    activeServerDir: params.activeServerDir,
    jobId: params.jobId,
  });
  return record;
}

export async function abortIfCancellationRequested(
  params: Pick<ExecuteWorkspaceReplicationJobParams, 'activeServerDir' | 'jobStore' | 'jobId' | 'now'>,
): Promise<WorkspaceReplicationJobRecord | null> {
  const current = await params.jobStore.read(params.jobId);
  if (!current) {
    throw new WorkspaceReplicationError({
      code: 'job_not_found',
      message: `Workspace replication job not found: ${params.jobId}`,
    });
  }
  if (!current.cancelRequestedAtMs && current.status.status !== 'aborted') {
    return null;
  }
  return await abortJobAndReturn(params);
}

export async function markJobFailedAndRethrow(
  params: Pick<ExecuteWorkspaceReplicationJobParams, 'activeServerDir' | 'jobStore' | 'jobId' | 'now'> & {
    error: unknown;
  },
): Promise<never> {
  try {
    await runWorkspaceReplicationJob({
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
      run: async () => {
        throw params.error;
      },
    });
  } finally {
    await removeWorkspaceReplicationJobStagingDirectory({
      activeServerDir: params.activeServerDir,
      jobId: params.jobId,
    });
  }
  throw params.error instanceof Error ? params.error : new Error('Workspace replication job failed');
}
