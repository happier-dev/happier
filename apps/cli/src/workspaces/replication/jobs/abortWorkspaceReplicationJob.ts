import type { WorkspaceReplicationJobRecord, WorkspaceReplicationJobStore } from './workspaceReplicationJobStore';
import {
  releaseWorkspaceReplicationJobLease,
  removeWorkspaceReplicationJobStagingDirectory,
  resolveWorkspaceReplicationJobLeaseTtlMs,
  tryAcquireWorkspaceReplicationJobLease,
} from '../state/workspaceReplicationJobLease';
import { isTerminalWorkspaceReplicationJobStatus } from './workspaceReplicationJobTerminalStatuses';

function isTerminalJobRecord(record: WorkspaceReplicationJobRecord): boolean {
  return isTerminalWorkspaceReplicationJobStatus(record.status.status);
}

export async function abortWorkspaceReplicationJob(params: Readonly<{
  jobStore: WorkspaceReplicationJobStore;
  jobId: string;
  // When available (daemon/runtime context), opportunistically acquire the job lease so we can
  // abort jobs that have no active runner and clean up staging immediately.
  activeServerDir?: string;
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

  // Without access to the lease/staging directories, we can only request cancellation and let
  // the active runner (if any) observe it.
  if (!params.activeServerDir) {
    const next: WorkspaceReplicationJobRecord = {
      ...current,
      updatedAtMs: nowMs,
      cancelRequestedAtMs: current.cancelRequestedAtMs ?? nowMs,
    };
    await params.jobStore.write(next);
    return next;
  }

  const leaseOwnerId = `cli-daemon:${process.pid}:abort`;
  const leaseAttempt = await tryAcquireWorkspaceReplicationJobLease({
    activeServerDir: params.activeServerDir,
    jobId: params.jobId,
    ownerId: leaseOwnerId,
    nowMs,
    ttlMs: resolveWorkspaceReplicationJobLeaseTtlMs(),
  });

  // If another runner holds the lease, avoid racing it: request cancellation only.
  if (!leaseAttempt.acquired) {
    const next: WorkspaceReplicationJobRecord = {
      ...current,
      updatedAtMs: nowMs,
      cancelRequestedAtMs: current.cancelRequestedAtMs ?? nowMs,
    };
    await params.jobStore.write(next);
    return next;
  }

  try {
    const next: WorkspaceReplicationJobRecord = {
      ...current,
      updatedAtMs: nowMs,
      cancelRequestedAtMs: current.cancelRequestedAtMs ?? nowMs,
      abortedAtMs: current.abortedAtMs ?? nowMs,
      status: {
        ...current.status,
        status: 'aborted',
      },
    };
    await params.jobStore.write(next);
    await removeWorkspaceReplicationJobStagingDirectory({
      activeServerDir: params.activeServerDir,
      jobId: params.jobId,
    });
    return (await params.jobStore.read(params.jobId)) ?? next;
  } finally {
    await releaseWorkspaceReplicationJobLease({
      activeServerDir: params.activeServerDir,
      jobId: params.jobId,
      ownerId: leaseOwnerId,
    }).catch(() => undefined);
  }
}
