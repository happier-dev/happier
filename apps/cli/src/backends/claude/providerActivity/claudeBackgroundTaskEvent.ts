import {
  classifyClaudeProviderTaskKind,
  type ClaudeProviderTaskKind,
} from './claudeProviderTaskClassification';

/**
 * Durable-record facts carried by the SAME typed Claude task lifecycle rows the liveness ledger
 * reads (PLAN 4.9).
 *
 * Liveness and durability are split exactly as t3code splits them: the ledger stays in-memory and
 * rebuildable, and only the outcome becomes a record. They are two projections of ONE parse — this
 * builder is called by `normalizeClaudeProviderTaskEvent` with the row it has already validated, so
 * there is never a second reader deciding independently what a `task_started` means.
 *
 * Field provenance is SDK-attested, verified in
 * `apps/cli/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:
 *
 * - `SDKTaskStartedMessage`      : `task_id`, `description`, `task_type?`, `tool_use_id?`, `session_id`
 * - `SDKTaskProgressMessage`     : `task_id`, `description`, `summary?`, `session_id`
 * - `SDKTaskNotificationMessage` : `task_id`, `status`, `summary`, `output_file`, `session_id`
 * - `SDKTaskUpdatedMessage`      : `task_id`, `patch.{status?,description?,end_time?,error?}`
 *
 * Deliberately absent, because the payloads do not carry them: there is NO `start_time` anywhere in
 * the SDK (only `patch.end_time`, on `task_updated`), and no `cwd` or `exit_code` on any task row.
 * Start time is therefore an observation stamp owned by the publisher, and a failed command without
 * an exit code is a designed state rather than a gap to fill with a guess.
 */
export type ClaudeBackgroundTaskFact =
  | Readonly<{
    type: 'started';
    sessionId: string;
    taskId: string;
    /** Stamped once here so persisted rows are self-describing. */
    kind: ClaudeProviderTaskKind;
    /** Raw `description`. UNREDACTED — redaction happens at the publisher, pre-persist. */
    label: string | null;
    /** The launching tool-use id: the join key to the originating `Bash` transcript card. */
    toolUseId: string | null;
  }>
  | Readonly<{
    type: 'progress';
    sessionId: string;
    taskId: string;
    /** Raw progress `description`. UNREDACTED — see above. */
    detail: string | null;
  }>
  | Readonly<{
    type: 'terminal';
    sessionId: string;
    taskId: string;
    status: 'completed' | 'failed' | 'stopped';
    /** Raw terminal `summary`/`patch.error`. UNREDACTED — see above. */
    summary: string | null;
    /** Provider-reported end time, present only on `task_updated`. */
    endedAt: number | null;
  }>;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Builds the durable-record projection for one already-validated typed task row.
 *
 * `identity` carries the id/session the caller has ALREADY normalized and (for liveness) gated, so
 * this function never re-derives identity and cannot disagree with the ledger about which task a
 * row belongs to.
 */
export function readClaudeBackgroundTaskFact(
  row: Readonly<Record<string, unknown>>,
  identity: Readonly<{ sessionId: string; taskId: string }>,
): ClaudeBackgroundTaskFact | null {
  if (row.subtype === 'task_started') {
    return {
      type: 'started',
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      kind: classifyClaudeProviderTaskKind(
        text(row.task_type) ?? text((row as { taskType?: unknown }).taskType),
      ),
      label: text(row.description),
      toolUseId: text(row.tool_use_id),
    };
  }

  if (row.subtype === 'task_progress') {
    return {
      type: 'progress',
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      detail: text(row.description) ?? text(row.summary),
    };
  }

  if (row.subtype === 'task_notification') {
    const status = row.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'stopped') return null;
    return {
      type: 'terminal',
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      status,
      summary: text(row.summary),
      endedAt: null,
    };
  }

  if (row.subtype === 'task_updated') {
    const patch = row.patch !== null && typeof row.patch === 'object' && !Array.isArray(row.patch)
      ? row.patch as Readonly<Record<string, unknown>>
      : null;
    const patched = patch?.status;
    if (patched !== 'completed' && patched !== 'failed' && patched !== 'killed') return null;
    return {
      type: 'terminal',
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      status: patched === 'killed' ? 'stopped' : patched,
      summary: text(patch?.error) ?? text(patch?.description),
      endedAt: finiteTimestamp(patch?.end_time),
    };
  }

  return null;
}
