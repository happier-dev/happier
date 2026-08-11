import type { BackgroundTaskKindV1 } from '@happier-dev/protocol';

/**
 * Claude provider-task classification vocabulary (PLAN 4.9.1 / 4.9.2).
 *
 * Two INDEPENDENT questions are answered here, by two separate functions over the same input:
 *
 * - `resolveClaudeProviderTaskAdmission` — *may this event open a liveness row that holds the
 *   turn open?*
 * - `classifyClaudeProviderTaskKind` — *is this an agent, a watch loop, or bookkeeping?*
 *
 * They are deliberately not one decision. `local_workflow` is the proof: agent-flavoured for
 * presentation, detached work for liveness. PLAN 8.4 makes "no change makes one decide both" a
 * completion-blocking negative, so any future edit must keep both tables independently readable.
 *
 * Admission is a DENYLIST, adopted from t3code with their production rationale: the SDK's
 * agent-flavoured type names drift (`subagent`, `local_agent`, `local_workflow`, ...) and an
 * allowlist silently dropped real work when a new name appeared. Happier had the mirror-image bug:
 * an allowlist of exactly two (`local_bash` | `local_workflow`) meant every other detached shape —
 * a `shell`, a `monitor`, a future `container_bash` — stopped being counted with nothing failing
 * loudly. A denylist fails the other way: an unrecognised name is treated as live detached work,
 * which is the honest default for a task the provider has told us started.
 */

/** May a typed lifecycle event open a liveness row of its own? */
export type ClaudeProviderTaskAdmission = 'admit' | 'known-only';

/**
 * Presentation bucket, stamped ONCE at ingestion so persisted rows are self-describing rather than
 * re-derived by every renderer.
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
 * Agent-flavoured type names. Membership decides PRESENTATION only — several of these still admit
 * for liveness (see `LIVENESS_DEFERRED_TASK_TYPES`).
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
 * Agent launches whose liveness is owned by the authenticated hook path
 * (`readClaudeSessionHookProviderTaskActivity`), not by the SDK's `task_started` echo. Admitting
 * them here would change turn lifecycle for every subagent launch — a behaviour change that PLAN
 * 4.9.1 forbids as a side effect of classification, so these keep their `known-only` admission.
 *
 * `local_workflow` is deliberately ABSENT: it admits today and continues to.
 */
const LIVENESS_DEFERRED_TASK_TYPES: ReadonlySet<string> = new Set([
  'agent',
  'local_agent',
  'remote_agent',
  'subagent',
]);

/**
 * A shell that outlives its turn. t3code files these with monitors in ONE set because their axis is
 * liveness bucketing; ours is presentation, where "a command finished" and "a watch loop is running"
 * are different sentences, so the record splits them (`BackgroundTaskKindV1`). Admission treats all
 * four identically, which is the part t3code's grouping was actually about.
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
 * CLI records it fails to compile rather than silently never being written.
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
 * Liveness admission for one typed `task_started`.
 *
 * `null` (no `task_type` on the payload) stays `known-only`: with no provider evidence of detached
 * work there is nothing to degrade to background, and the authenticated hook remains the owner.
 */
export function resolveClaudeProviderTaskAdmission(
  taskType: string | null | undefined,
): ClaudeProviderTaskAdmission {
  const normalized = normalizeTaskType(taskType);
  if (normalized === null) return 'known-only';
  if (LIVENESS_DEFERRED_TASK_TYPES.has(normalized)) return 'known-only';
  if (INERT_TASK_TYPES.has(normalized)) return 'known-only';
  return 'admit';
}

/**
 * Presentation kind for one typed task.
 *
 * An untyped task is the generic Task/Agent case, so it classifies `agent` and is never persisted
 * as a headless command.
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
