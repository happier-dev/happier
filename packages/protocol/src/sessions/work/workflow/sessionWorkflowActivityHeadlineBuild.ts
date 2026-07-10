import type {
  SessionWorkflowActivityHeadlineTruncationV1,
  SessionWorkflowActivityHeadlineV1,
  SessionWorkflowRunHeadlineV1,
} from './sessionWorkflowActivityHeadlineV1.js';
import type { SessionWorkflowRunStatusV1 } from './sessionWorkflowRunSnapshotV1.js';

/**
 * Default terminal-history bound for the compact metadata headline. Only `recentRuns` is
 * bounded; `activeRuns` is never capped because active concurrency is provider behavior, not
 * a Happier-imposed limit. Terminal `activity/workflow_run.v1` records remain durable history.
 */
export const SESSION_WORKFLOW_ACTIVITY_RECENT_RUNS_LIMIT = 5;

const TERMINAL_WORKFLOW_RUN_STATUSES: ReadonlySet<SessionWorkflowRunStatusV1> = new Set([
  'complete',
  'failed',
  'stopped',
  'cancelled',
]);

export function isTerminalWorkflowRunStatus(status: SessionWorkflowRunStatusV1): boolean {
  return TERMINAL_WORKFLOW_RUN_STATUSES.has(status);
}

// Active-run attention priority: runs needing user attention (blocked) first, then active,
// then pending/unknown. Run statuses do not include a literal `pending`, but the comparator
// keeps that tier so the rule stays stable if a provider ever surfaces one. Ordinary progress
// timestamps intentionally do NOT participate in active ordering: workflows update frequently, and
// sorting by `updatedAt` makes the compact badge and popover reorder on every progress tick.
function activeRunStatusPriority(status: SessionWorkflowRunStatusV1 | 'pending'): number {
  switch (status) {
    case 'blocked':
      return 0;
    case 'active':
      return 1;
    case 'pending':
      return 2;
    default:
      return 3;
  }
}

function compareActiveWorkflowRunHeadlines(a: SessionWorkflowRunHeadlineV1, b: SessionWorkflowRunHeadlineV1): number {
  const priorityDelta = activeRunStatusPriority(a.status) - activeRunStatusPriority(b.status);
  if (priorityDelta !== 0) return priorityDelta;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0; // runId ascending tie-break
}

function compareTerminalWorkflowRunHeadlines(a: SessionWorkflowRunHeadlineV1, b: SessionWorkflowRunHeadlineV1): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt; // updatedAt descending
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0; // runId ascending tie-break
}

/** Deterministic active-run ordering shared by every client so they agree on `primaryRunId`. */
export function sortActiveWorkflowRunHeadlines(
  runs: readonly SessionWorkflowRunHeadlineV1[],
): SessionWorkflowRunHeadlineV1[] {
  return [...runs].sort(compareActiveWorkflowRunHeadlines);
}

/**
 * `primaryRunId` is a derived hint, not a second source of truth. It is `null` when there are
 * no active runs; otherwise it is the first run after deterministic active-run sorting.
 */
export function resolvePrimaryWorkflowRunId(
  activeRuns: readonly SessionWorkflowRunHeadlineV1[],
): string | null {
  const sorted = sortActiveWorkflowRunHeadlines(activeRuns);
  return sorted[0]?.runId ?? null;
}

/** Bound only terminal history; never bound active concurrency. */
export function boundRecentWorkflowRunHeadlines(
  terminalRuns: readonly SessionWorkflowRunHeadlineV1[],
  limit: number = SESSION_WORKFLOW_ACTIVITY_RECENT_RUNS_LIMIT,
): { recentRuns: SessionWorkflowRunHeadlineV1[]; truncated?: SessionWorkflowActivityHeadlineTruncationV1 } {
  const sorted = [...terminalRuns].sort(compareTerminalWorkflowRunHeadlines);
  const recentRuns = sorted.slice(0, Math.max(0, limit));
  const omittedCount = sorted.length - recentRuns.length;
  if (omittedCount > 0) {
    return { recentRuns, truncated: { reason: 'run_limit', omittedCount } };
  }
  return { recentRuns };
}

/**
 * Project a run to the count-only headline field set. The producer guards the
 * "headline never holds workflow detail" invariant here (§3.3): a caller passing a
 * detail-bearing snapshot object can never leak phases/agents/previews into the compact
 * session-metadata headline, regardless of structural typing. Pairs with the strip-by-default
 * schema for defence in depth.
 */
export function projectWorkflowRunHeadline(run: SessionWorkflowRunHeadlineV1): SessionWorkflowRunHeadlineV1 {
  const projected: SessionWorkflowRunHeadlineV1 = {
    runId: run.runId,
    title: run.title,
    status: run.status,
    updatedAt: run.updatedAt,
    recordRevision: run.recordRevision,
    recordUpdatedAt: run.recordUpdatedAt,
    totalAgents: run.totalAgents,
    completedAgents: run.completedAgents,
  };
  if (run.statusReason !== undefined) projected.statusReason = run.statusReason;
  if (run.workflowToolUseId !== undefined) projected.workflowToolUseId = run.workflowToolUseId;
  if (run.failedAgents !== undefined) projected.failedAgents = run.failedAgents;
  if (run.blockedAgents !== undefined) projected.blockedAgents = run.blockedAgents;
  return projected;
}

export type BuildSessionWorkflowActivityHeadlineInput = Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  runs: readonly SessionWorkflowRunHeadlineV1[];
  recentRunsLimit?: number;
}>;

/**
 * Build the compact headline from a flat list of run headlines. Partitions active vs terminal
 * runs, keeps every active run, bounds terminal history, and computes a deterministic
 * `primaryRunId`. This is the single shared builder reused by the publisher and mirrored from
 * remote-dev, so multiple clients agree on ordering and primary selection.
 */
export function buildSessionWorkflowActivityHeadline(
  input: BuildSessionWorkflowActivityHeadlineInput,
): SessionWorkflowActivityHeadlineV1 {
  const active: SessionWorkflowRunHeadlineV1[] = [];
  const terminal: SessionWorkflowRunHeadlineV1[] = [];
  for (const rawRun of input.runs) {
    // Project at the single producer chokepoint so detail can never reach the headline.
    const run = projectWorkflowRunHeadline(rawRun);
    if (isTerminalWorkflowRunStatus(run.status)) {
      terminal.push(run);
    } else {
      active.push(run);
    }
  }

  const activeRuns = sortActiveWorkflowRunHeadlines(active);
  const { recentRuns, truncated } = boundRecentWorkflowRunHeadlines(terminal, input.recentRunsLimit);

  const headline: SessionWorkflowActivityHeadlineV1 = {
    v: 1,
    backendId: input.backendId,
    updatedAt: input.updatedAt,
    primaryRunId: activeRuns[0]?.runId ?? null,
    activeRuns,
  };
  if (input.agentId) headline.agentId = input.agentId;
  if (recentRuns.length > 0) headline.recentRuns = recentRuns;
  if (truncated) headline.truncated = truncated;
  return headline;
}
