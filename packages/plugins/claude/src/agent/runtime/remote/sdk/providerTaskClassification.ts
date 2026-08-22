import type { BackgroundTaskKindV1 } from '@happier-dev/plugin-sdk/sessions/work-state';

/**
 * Claude provider-task classification vocabulary.
 *
 * This module answers ONE question about a provider task: *what kind of work is it?* It deliberately
 * does not answer the other one — *may this event open a liveness row that holds the turn open?* —
 * which stays with `readStrictClaudeProviderTaskActivity`'s admission decision in
 * `providerActivity.ts`.
 *
 * They are not one decision, and `local_workflow` is the proof: agent-flavoured for presentation,
 * detached work for liveness. Keeping them separate means no single edit can make one function
 * decide both.
 */

/**
 * Presentation bucket, stamped ONCE at ingestion so persisted rows are self-describing rather than
 * re-derived by every reader from a provider string that drifts between SDK releases.
 *
 * The recorded members ARE `BackgroundTaskKindV1`, not a parallel vocabulary translated into it:
 * this union is that protocol enum plus the two buckets that never earn a durable record, so there
 * is no mapping table to drift.
 */
export type ClaudeProviderTaskKind =
  | BackgroundTaskKindV1
  /** Agent-flavoured work. Rostered through the subagent/workflow paths, never as a headless command. */
  | 'agent'
  /** Provider bookkeeping that is not user-visible activity at all. */
  | 'inert';

/**
 * Agent-flavoured type names. Membership decides PRESENTATION only; several of these are still
 * admitted for liveness elsewhere.
 */
const AGENT_FLAVOURED_TASK_TYPES: ReadonlySet<string> = new Set([
  'agent',
  'local_agent',
  'remote_agent',
  'subagent',
  'local_workflow',
  'remote_workflow',
  'workflow',
]);

/**
 * A shell that outlives its turn. "A command finished" and "a watch loop is running" are different
 * sentences, so the record splits them rather than filing both under one liveness bucket.
 */
const COMMAND_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_bash',
  'shell',
]);

/** Watch loops. Recognised so a provider that starts emitting them classifies instead of dropping. */
const MONITORING_TASK_TYPES: ReadonlySet<string> = new Set([
  'monitor',
  'monitor_mcp',
]);

/** Bookkeeping types that are not user-visible activity: no liveness row, no durable record. */
const INERT_TASK_TYPES: ReadonlySet<string> = new Set([
  'plan',
  'dream',
]);

/**
 * Kinds whose work is headless and therefore earns a durable `activity/background_task.v1` record.
 *
 * Typed as the protocol enum so adding a `BackgroundTaskKindV1` member without deciding whether the
 * producer records it fails to compile rather than silently never being written.
 */
const RECORDED_TASK_KINDS: ReadonlySet<ClaudeProviderTaskKind> = new Set<BackgroundTaskKindV1>([
  'command',
  'monitoring',
  'unknown',
]);

function normalizeTaskType(taskType: string | null | undefined): string | null {
  if (typeof taskType !== 'string') return null;
  const trimmed = taskType.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Presentation kind for one typed task.
 *
 * An untyped task is the generic Task/Agent case, so it classifies `agent` and is never persisted as
 * a headless command. A typed task this build does not recognise classifies `unknown` — honest, and
 * still recorded — rather than being guessed into the agent roster.
 */
export function classifyClaudeProviderTaskKind(
  taskType: string | null | undefined,
): ClaudeProviderTaskKind {
  const normalized = normalizeTaskType(taskType);
  if (normalized === null) return 'agent';
  if (INERT_TASK_TYPES.has(normalized)) return 'inert';
  if (COMMAND_TASK_TYPES.has(normalized)) return 'command';
  if (MONITORING_TASK_TYPES.has(normalized)) return 'monitoring';
  if (AGENT_FLAVOURED_TASK_TYPES.has(normalized)) return 'agent';
  return 'unknown';
}

/** True when this kind is headless work that earns a durable background-task record. */
export function isRecordedClaudeProviderTaskKind(
  kind: ClaudeProviderTaskKind,
): kind is BackgroundTaskKindV1 {
  return RECORDED_TASK_KINDS.has(kind);
}
