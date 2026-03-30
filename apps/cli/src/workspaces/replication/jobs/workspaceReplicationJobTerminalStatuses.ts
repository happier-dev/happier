export const WORKSPACE_REPLICATION_JOB_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'aborted',
  'failed',
  'awaiting_recovery',
] as const;

export type WorkspaceReplicationJobStatus = (typeof WORKSPACE_REPLICATION_JOB_STATUSES)[number];

const TERMINAL_WORKSPACE_REPLICATION_JOB_STATUSES = new Set<WorkspaceReplicationJobStatus>([
  'completed',
  'aborted',
  'failed',
  'awaiting_recovery',
]);

export function isTerminalWorkspaceReplicationJobStatus(
  status: WorkspaceReplicationJobStatus,
): boolean {
  return TERMINAL_WORKSPACE_REPLICATION_JOB_STATUSES.has(status);
}
