/**
 * The single source of truth for Claude task/subagent/progress status normalization.
 *
 * This neutral 7-value vocabulary is the canonical signal every Claude-owned surface (work-state
 * task/todo rows AND workflow run/agent snapshots) projects from, so status normalization can never
 * drift across them. It mirrors the protocol `SessionWorkflowAgentStatusV1` shape.
 *
 * The Task-API work-state mapper (`normalizeTaskStatus`) and the CWF2 workflow normalizer both
 * delegate here. Do NOT add a parallel status table elsewhere.
 */
export type ClaudeActivityStatusSignal =
  | 'pending'
  | 'active'
  | 'complete'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'unknown';

export function normalizeClaudeActivityStatusSignal(status: unknown, type?: string): ClaudeActivityStatusSignal {
  if (status === 'completed' || status === 'complete' || status === 'done') return 'complete';
  if (status === 'stopped' || status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'pending') return 'pending';
  if (
    status === 'running'
    || status === 'active'
    || status === 'in_progress'
    || status === 'progress'
    || type === 'task_started'
    || type === 'task_progress'
  ) {
    return 'active';
  }
  return 'unknown';
}

export function normalizeClaudeAgentSdkProviderTaskId(taskId: unknown): string | null {
  if (typeof taskId !== 'string') return null;
  const normalized = taskId.trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeClaudeAgentSdkProviderTaskStatus(status: unknown): string | null {
  if (typeof status !== 'string') return null;
  const normalized = status.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function readClaudeAgentSdkProviderTaskStatus(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const directStatus = normalizeClaudeAgentSdkProviderTaskStatus(record.status);
  if (directStatus) return directStatus;

  const patch = record.patch;
  if (!patch || typeof patch !== 'object') return null;
  return normalizeClaudeAgentSdkProviderTaskStatus((patch as Record<string, unknown>).status);
}

export function isTerminalClaudeAgentSdkProviderTaskStatus(status: unknown): boolean {
  switch (normalizeClaudeAgentSdkProviderTaskStatus(status)) {
    case 'completed':
    case 'succeeded':
    case 'success':
    case 'stopped':
    case 'failed':
    case 'error':
    case 'errored':
    case 'killed':
    case 'cancelled':
    case 'canceled':
      return true;
    default:
      return false;
  }
}
