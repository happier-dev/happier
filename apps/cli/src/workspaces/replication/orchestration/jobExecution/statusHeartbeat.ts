import { runWorkspaceReplicationJob } from '@/workspaces/replication/jobs/runWorkspaceReplicationJob';
import type { WorkspaceReplicationJobRecord, WorkspaceReplicationJobStore } from '@/workspaces/replication/jobs/workspaceReplicationJobStore';

export async function runWithWorkspaceReplicationJobStatusHeartbeat<T>(params: Readonly<{
  heartbeatIntervalMs: number;
  jobStore: WorkspaceReplicationJobStore;
  jobId: string;
  now?: () => number;
  run: () => Promise<T>;
}>): Promise<T> {
  let statusHeartbeatStopped = false;
  const statusHeartbeatState: { inFlight: Promise<void> | null } = { inFlight: null };
  const probeStatusHeartbeatOnce = async (): Promise<void> => {
    if (statusHeartbeatStopped) return;
    if (statusHeartbeatState.inFlight) {
      try {
        await statusHeartbeatState.inFlight;
      } catch {
        // ignore
      }
      return;
    }
    statusHeartbeatState.inFlight = runWorkspaceReplicationJob({
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
      run: async (record: WorkspaceReplicationJobRecord) => record,
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        statusHeartbeatState.inFlight = null;
      });
    try {
      await statusHeartbeatState.inFlight;
    } catch {
      // ignore
    }
  };

  const statusHeartbeatHandle = setInterval(probeStatusHeartbeatOnce, params.heartbeatIntervalMs);
  statusHeartbeatHandle.unref?.();

  try {
    return await params.run();
  } finally {
    statusHeartbeatStopped = true;
    clearInterval(statusHeartbeatHandle);
    if (statusHeartbeatState.inFlight) {
      try {
        await statusHeartbeatState.inFlight;
      } catch {
        // ignore
      }
    }
  }
}
