import { hasActiveSessionRuntimeActivity } from '../runtime/activity/sessionRuntimeActivity.js';
import type { PrimaryTurnStatusV1 } from '../control/runtimeIssueV1.js';
import {
  normalizeAwarenessCountV1,
  normalizeAwarenessTimestampV1,
  type SessionAwarenessComponentEvidenceV1,
  type SessionAwarenessCurrentnessInputV1,
  type SessionLifecycleAwarenessInputV1,
  type SessionPendingAwarenessInputV1,
  type SessionRuntimeAwarenessInputV1,
} from './inputV1.js';
import type {
  SessionAwarenessFreshnessV1,
  SessionAwarenessLifecycleV1,
  SessionAwarenessRuntimeV1,
} from './projectionV1.js';

/**
 * Lifecycle, runtime and freshness semantics — the platform-neutral core extracted from the UI's
 * `deriveSessionRuntimePresentationState`, which was the richest but not the only implementation.
 *
 * The three answers stay orthogonal (AWI-03): "what is the Session's lifecycle", "what is its
 * runtime doing" and "how current is that evidence" are separate questions, and collapsing them
 * is exactly how a surface ends up calling an offline session idle or an archived session busy.
 */

/**
 * How long a runtime signal stays meaningful after it was observed. One bound for thinking,
 * pending-request freshness and "the runtime is gone rather than merely quiet", because a
 * consumer that re-spells any of them with a different budget drifts from the rest.
 */
export const SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS = 120_000;

/**
 * The much shorter budget for a purely local optimistic "the prompt was accepted" marker. It is
 * not runtime evidence, so it may not keep a row spinning for the full runtime bound.
 */
export const SESSION_AWARENESS_OPTIMISTIC_PENDING_INPUT_MS = 15_000;

/**
 * Clock skew tolerated before activity newer than a terminal turn projection is believed. Without
 * it, a timestamp written a few milliseconds apart would flip a completed turn out of `ready`.
 */
export const SESSION_AWARENESS_TERMINAL_ACTIVITY_SKEW_MS = 1_000;

export function isFreshAwarenessTimestampV1(
  timestamp: number | null | undefined,
  nowMs: number,
  budgetMs: number,
): boolean {
  const normalized = normalizeAwarenessTimestampV1(timestamp);
  return normalized !== null && normalized + budgetMs > nowMs;
}

export function hasTerminalPrimaryTurnStatusV1(
  status: PrimaryTurnStatusV1 | null | undefined,
): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

export function hasProjectedActiveTurnV1(
  status: string | null | undefined,
): boolean {
  return status === 'in_progress';
}

/** Presence and the Session's own persisted turn are independent, clock-free facts. */
export function isProjectedSessionStalledV1(input: Readonly<{
  active?: boolean | null;
  latestTurnStatus?: string | null;
}>): boolean {
  return input.active === false && hasProjectedActiveTurnV1(input.latestTurnStatus);
}

export function hasActivityClearlyAfterTerminalProjectionV1(
  meaningfulActivityAtMs: number | null | undefined,
  latestTurnStatusObservedAtMs: number | null | undefined,
): boolean {
  const activityAt = normalizeAwarenessTimestampV1(meaningfulActivityAtMs);
  const observedAt = normalizeAwarenessTimestampV1(latestTurnStatusObservedAtMs);
  return activityAt !== null
    && observedAt !== null
    && activityAt > observedAt + SESSION_AWARENESS_TERMINAL_ACTIVITY_SKEW_MS;
}

export function normalizeAwarenessSequenceV1(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/**
 * Whether the lifecycle and runtime components a boundary just normalized actually carry evidence.
 *
 * Each boundary keeps its own normalizer, but this is a classification of the already-normalized
 * component inputs, so it is decided once here: two adapters that build the same lifecycle facts
 * must not disagree about whether they observed them (a published ready sequence is lifecycle
 * evidence, and a row with no reachability, activity or thinking fact asserts no runtime
 * evidence). `pending` and `work` stay caller-supplied because only the acquiring boundary knows
 * whether its snapshot carried a pending projection or readable metadata at all.
 */
export function resolveAwarenessCurrentnessV1(params: Readonly<{
  lifecycle: SessionLifecycleAwarenessInputV1;
  runtime: SessionRuntimeAwarenessInputV1;
  pending: SessionAwarenessComponentEvidenceV1;
  work?: SessionAwarenessComponentEvidenceV1;
  observedAtMs?: number | null;
}>): SessionAwarenessCurrentnessInputV1 {
  const hasLifecycleEvidence = normalizeAwarenessTimestampV1(params.lifecycle.archivedAtMs) !== null
    || params.lifecycle.processTerminalState === 'stopped'
    || params.lifecycle.latestTurnStatus !== undefined
    || normalizeAwarenessSequenceV1(params.lifecycle.latestReadyEventSeq) !== null;
  const hasRuntimeEvidence = params.runtime.presence !== 'unknown'
    || typeof params.runtime.active === 'boolean'
    || typeof params.runtime.thinking === 'boolean'
    || (params.runtime.activityState ?? null) !== null
    || typeof params.runtime.activityActiveCount === 'number';
  return {
    lifecycle: hasLifecycleEvidence ? 'observed' : 'unavailable',
    runtime: hasRuntimeEvidence ? 'observed' : 'unavailable',
    pending: params.pending,
    ...(params.work === undefined ? {} : { work: params.work }),
    ...(params.observedAtMs === undefined ? {} : { observedAtMs: params.observedAtMs }),
  };
}

/**
 * The intermediate runtime facts every operational decision is built from. Exported so migrated
 * consumers that genuinely need a component (a freshness timer, an abort-availability check) can
 * read it from the canonical owner instead of re-deriving a private ladder.
 */
export type SessionAwarenessRuntimeFactsV1 = Readonly<{
  archived: boolean;
  terminalStatus: PrimaryTurnStatusV1 | null;
  hasTerminalPrimaryTurnProjection: boolean;
  live: boolean;
  unservable: boolean;
  projectedTurnInProgress: boolean;
  freshThinking: boolean;
  freshOptimisticPendingInput: boolean;
  resuming: boolean;
  working: boolean;
  backgroundActive: boolean;
  reportedActiveCount: number;
  freshPermissionRequired: boolean;
  freshActionRequired: boolean;
  blockedInput: boolean;
  queuedInput: boolean;
  lostSinceMs: number | null;
  lastObservedAtMs: number | null;
  runtime: SessionAwarenessRuntimeV1;
  freshness: SessionAwarenessFreshnessV1;
}>;

export type ProjectSessionAwarenessRuntimeV1Input = Readonly<{
  nowMs: number;
  lifecycle: SessionLifecycleAwarenessInputV1;
  runtime: SessionRuntimeAwarenessInputV1;
  pending: SessionPendingAwarenessInputV1;
  runtimeEvidenceUnavailable?: boolean;
  /** Observation ceiling for callers projecting a retained/delayed aggregate snapshot. */
  currentnessObservedAtMs?: number | null;
}>;

/**
 * Whether the Session's runtime is running: durable `active`, not contradicted by an observed
 * detach. Unobserved presence (a fresh client before the runtime next publishes) is not a stop.
 * `isLiveSessionRuntimeV1` is the separate "this device observes a live connection" fact.
 */
export function isSessionRuntimeRunningV1(
  input: Readonly<{ presence: 'online' | 'offline' | 'unknown'; active?: boolean | null }>,
  archived: boolean,
): boolean {
  return !archived && input.active === true && input.presence !== 'offline';
}

/**
 * Whether the runtime that publishes this Session's state is still there to publish it.
 *
 * One owner for "live", because it is the precondition of every claim derived from a report the
 * runtime made. An archived Session is not live no matter what its last report said, so a
 * consumer that re-spells the rule as `active && online` reads an archived Session's final
 * in-progress projection as work still happening.
 */
export function isLiveSessionRuntimeV1(
  input: Readonly<{ presence: 'online' | 'offline' | 'unknown'; active?: boolean | null }>,
  archived: boolean,
): boolean {
  return !archived && input.active === true && input.presence === 'online';
}

export function resolveSessionAwarenessLifecycleV1(
  lifecycle: SessionLifecycleAwarenessInputV1,
  evidenceUnavailable: boolean,
): SessionAwarenessLifecycleV1 {
  if (evidenceUnavailable) return 'unknown';
  if (normalizeAwarenessTimestampV1(lifecycle.archivedAtMs) !== null) return 'archived';
  switch (lifecycle.latestTurnStatus) {
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
      return 'ready';
    case 'in_progress':
    case 'waiting':
      return 'active';
    default:
      return 'unknown';
  }
}

export function projectSessionAwarenessRuntimeV1(
  input: ProjectSessionAwarenessRuntimeV1Input,
): SessionAwarenessRuntimeFactsV1 {
  const { nowMs, lifecycle, pending } = input;
  const runtimeEvidenceUnavailable = input.runtimeEvidenceUnavailable === true;
  const runtime: SessionRuntimeAwarenessInputV1 = runtimeEvidenceUnavailable
    ? { presence: 'unknown' }
    : input.runtime;
  // Presence is device-observed, so durable `active: true` never manufactures it. Durable
  // `active: false` is different: the presence owner writes it when the runtime detaches, so a row
  // hydrated without a device observation still knows its runtime is gone rather than unknown.
  const presence = runtime.presence === 'unknown' && runtime.active === false ? 'offline' : runtime.presence;

  const archived = normalizeAwarenessTimestampV1(lifecycle.archivedAtMs) !== null;
  const waitingForAction = !archived && lifecycle.latestTurnStatus === 'waiting';
  const hasTerminalPrimaryTurnProjection = hasTerminalPrimaryTurnStatusV1(lifecycle.latestTurnStatus);
  const terminalStatus = hasTerminalPrimaryTurnProjection ? lifecycle.latestTurnStatus ?? null : null;
  const unservable = runtime.controlServiceability === 'recoverable_unservable';
  const live = !unservable && isLiveSessionRuntimeV1(runtime, archived);

  const queuedInput = normalizeAwarenessCountV1(pending.queuedInputCount) > 0;
  const blockedInput = normalizeAwarenessCountV1(pending.blockedInputCount) > 0;

  // The lifecycle projection is the canonical active-turn fact. It is cleared by
  // complete/fail/cancel (including daemon exit settlement), not elapsed wall time.
  const projectedTurnInProgress = !archived && hasProjectedActiveTurnV1(lifecycle.latestTurnStatus);
  const freshThinking = runtime.thinking === true
    && live
    && isFreshAwarenessTimestampV1(runtime.thinkingAtMs, nowMs, SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS)
    && !hasTerminalPrimaryTurnProjection && !waitingForAction;
  const freshOptimisticPendingInput = queuedInput
    && live
    && isFreshAwarenessTimestampV1(
      runtime.optimisticThinkingAtMs,
      nowMs,
      SESSION_AWARENESS_OPTIMISTIC_PENDING_INPUT_MS,
    )
    && !hasTerminalPrimaryTurnProjection && !waitingForAction;

  // A resume request is in flight whenever the Session carries the marker. It only counts as
  // work-in-progress while no terminal turn projection contradicts it — resuming a completed
  // Session is ordinary, and it must not repaint that row as an active turn.
  const resuming = !archived && normalizeAwarenessTimestampV1(runtime.resumingAtMs) !== null;

  const working = projectedTurnInProgress
    || freshThinking
    || freshOptimisticPendingInput
    || (resuming && !hasTerminalPrimaryTurnProjection && !waitingForAction);

  const activity = { state: runtime.activityState, activeCount: normalizeAwarenessCountV1(runtime.activityActiveCount) };
  const reportedActiveCount = !archived && hasActiveSessionRuntimeActivity(activity) ? activity.activeCount : 0;
  const backgroundActive = !working && reportedActiveCount > 0;

  // Pending facts and runtime reachability are orthogonal. A host can observe the runtime's
  // active projection without owning a presence channel (the CLI V2 row is the concrete case).
  // Preserve actionable pending evidence unless reachability is known offline; unavailable
  // runtime evidence has already been replaced above and therefore cannot satisfy `active`.
  const potentiallyLive = !unservable && isSessionRuntimeRunningV1(runtime, archived);
  // Keep an outstanding request visible until its count clears or its owning runtime is no
  // longer live. The request timestamp need not advance while it waits, so age is not settlement
  // evidence. Updated CLIs retain and retry settlement intents; older producers can leave an
  // unresolved count after a failed cancellation write.
  const freshActionRequired = waitingForAction || (pending.hasPendingUserActionRequests === true
    && potentiallyLive);
  const freshPermissionRequired = pending.hasPendingPermissionRequests === true
    && potentiallyLive;

  const runtimeObservedAtMs = normalizeAwarenessTimestampV1(runtime.lastObservedAtMs);
  const currentnessObservedAtMs = normalizeAwarenessTimestampV1(input.currentnessObservedAtMs);
  // A delayed aggregate cannot be fresher than the instant at which its component facts were
  // observed. Keep an older component timestamp when one exists; otherwise the aggregate
  // observation supplies the same existing runtime-freshness fact rather than a second clock.
  const lastObservedAtMs = runtimeObservedAtMs === null
    ? currentnessObservedAtMs
    : currentnessObservedAtMs === null
      ? runtimeObservedAtMs
      : Math.min(runtimeObservedAtMs, currentnessObservedAtMs);
  const lostSinceMs = live || lastObservedAtMs === null
    ? null
    : nowMs - lastObservedAtMs > SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS
      ? lastObservedAtMs
      : null;

  const runtimeState = ((): SessionAwarenessRuntimeV1 => {
    if (unservable) return 'offline';
    if (runtimeEvidenceUnavailable || presence === 'unknown') return 'unknown';
    if (presence === 'offline') return 'offline';
    if (waitingForAction) return 'waiting';
    if (working) return 'working';
    if (backgroundActive) return 'background_active';
    if (freshPermissionRequired || freshActionRequired) return 'waiting';
    return 'idle';
  })();

  const freshness = ((): SessionAwarenessFreshnessV1 => {
    if (runtimeEvidenceUnavailable) return 'unknown';
    if (unservable) return 'offline';
    if (presence === 'unknown') return 'unknown';
    if (presence === 'offline' || !live) {
      if (lostSinceMs !== null) return 'offline';
      return lastObservedAtMs === null ? 'unknown' : 'stale';
    }
    return lastObservedAtMs !== null
      && nowMs - lastObservedAtMs > SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS
      ? 'stale'
      : 'live';
  })();

  return {
    archived,
    terminalStatus,
    hasTerminalPrimaryTurnProjection,
    live,
    unservable,
    projectedTurnInProgress,
    freshThinking,
    freshOptimisticPendingInput,
    resuming,
    working,
    backgroundActive,
    reportedActiveCount,
    freshPermissionRequired,
    freshActionRequired,
    blockedInput,
    queuedInput,
    lostSinceMs,
    lastObservedAtMs,
    runtime: runtimeState,
    freshness,
  };
}

/**
 * Whether this Session has finished a turn and nothing newer has happened since — the neutral
 * half of the old list ladder's `ready`. The other half ("and this viewer has not seen it") is
 * viewer read state and belongs to 09B, never here.
 */
export function hasSessionAwarenessReadyEvidenceV1(
  lifecycle: SessionLifecycleAwarenessInputV1,
  evidenceUnavailable: boolean,
): boolean {
  if (evidenceUnavailable) return false;
  if (lifecycle.latestTurnStatus === 'in_progress'
    || lifecycle.latestTurnStatus === 'waiting'
    || lifecycle.latestTurnStatus === 'failed'
    || (lifecycle.latestTurnStatus === 'cancelled' && lifecycle.processTerminalState === 'stopped')
    || normalizeAwarenessTimestampV1(lifecycle.archivedAtMs) !== null) return false;
  const readySeq = normalizeAwarenessSequenceV1(lifecycle.latestReadyEventSeq);
  if (readySeq !== null && readySeq > 0) return true;
  if (lifecycle.latestTurnStatus !== 'completed' && lifecycle.latestTurnStatus !== 'cancelled') return false;
  return !hasActivityClearlyAfterTerminalProjectionV1(
    lifecycle.meaningfulActivityAtMs,
    lifecycle.latestTurnStatusObservedAtMs,
  );
}
