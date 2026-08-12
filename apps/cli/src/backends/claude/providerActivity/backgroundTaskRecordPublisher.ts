import { homedir } from 'node:os';

import {
  buildBackgroundTaskSystemRecordLocalId,
  isTerminalAgentActivityStatus,
  redactBackgroundCommand,
  type AgentActivityStatusV1,
  type BackgroundTaskKindV1,
  type SessionBackgroundTaskRecordV1,
} from '@happier-dev/protocol';

import { isPermanentRequestError } from '@/api/client/httpStatusError';
import { createCoalescedScheduler } from '@/utils/coalescedScheduler';
import { toHomeRelativePath } from '@/session/handoff/paths/sessionHandoffPathNormalization';

import type { ClaudeBackgroundTaskFact } from './claudeBackgroundTaskEvent';
import { isRecordedClaudeProviderTaskKind } from './claudeProviderTaskClassification';

/**
 * Durable publisher for `activity/background_task.v1` (PLAN 4.9, R-9).
 *
 * The liveness/durability split is t3code's and it is the right one: the provider ledger stays
 * in-memory and rebuildable, and ONLY the outcome becomes a record. Nothing here participates in
 * `hasActiveProviderTasks()`, so a publish failure can never hold a turn open or settle one early.
 *
 * It reuses the activity seam rather than adding a second one: `createCoalescedScheduler` (the same
 * primitive the workflow publisher drains through) for one-in-flight/one-follow-up, and the caller's
 * `commitRecord`, which the composition seam binds to the session's encryption mode and system-record
 * transport exactly as the workflow record commit is bound.
 *
 * Per-task failure isolation mirrors the workflow publisher: a RETRYABLE rejected write re-marks
 * ONLY that task dirty and the next drain rewrites it from current state, so a retry is idempotent
 * (the local id is stable) and one bad task never blocks another.
 *
 * A PERMANENT rejection is dropped instead. `activity/background_task.v1` is validated server-side,
 * so a server released before the kind existed answers 400 to every attempt; re-queueing that would
 * be a debounce-interval PUT loop per task for the session's lifetime. PLAN 5.2's expand phase says
 * an older server ignores what it does not know - the row is simply absent and the UI degrades -
 * not that it is hammered until the session ends.
 */

/** Publisher-visible view of one background task, immediately before sealing. */
type TrackedBackgroundTask = {
  kind: BackgroundTaskKindV1;
  status: AgentActivityStatusV1;
  label?: string;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  updatedAt: number;
};

export type BackgroundTaskRecordPublisher = Readonly<{
  /** Observe one durable-record fact. Non-recorded kinds and unknown tasks are inert. */
  observe(fact: ClaudeBackgroundTaskFact): void;
  /**
   * Resolve every still-outstanding record to `cancelled`, for an ORDERLY STOP ONLY.
   *
   * **Nothing else ever finalizes one of these.** A background shell reports through the provider's
   * transcript, so when the provider is gone the record's only reporter is gone with it: a durable
   * `SessionBackgroundTaskRecordV1` left at `running` stays `running` through the stop, through the
   * resume, and forever — no startup reconcile reads this namespace and the workflow tracker never
   * held these tasks (`rg backgroundTask claudeWorkflowActivityTracker.ts` -> 0 hits).
   *
   * **Orderly stop only, and the distinction is the whole contract.** Call this when the kill was
   * OURS and we watched it happen — the caller destroyed the process tree the shell lived in, so
   * "it stopped" is a recorded observation. Do NOT call it after a provider crash: a detached shell
   * survives its parent, may genuinely still be writing, and `cancelled` would be a durable lie
   * about work nobody watched (RULING-14 forbids exactly that inference). Do NOT call it on resume:
   * a new process has observed nothing about the old one's children.
   *
   * `cancelled`, never `failed`: a stop is a stop, and PLAN 4.2 forbids painting it danger. The end
   * instant is the last one we actually observed, never a fabricated one — the same rule the
   * workflow tracker applies to an interrupted agent's `completedAt`.
   *
   * Idempotent: a second call finds nothing outstanding and writes nothing.
   */
  finalizeOutstandingOnOrderlyStop(): void;
  /** Drain pending writes immediately (terminal flush / stream close / session finalization). */
  flush(): Promise<void>;
  /** Stop scheduling. */
  dispose(): void;
}>;

/**
 * Provider terminal word -> the ONE presentation status vocabulary (PLAN 8.4: no second status
 * enum). `stopped` is `cancelled`, never `failed`: a stop is the user's own action and 4.2 forbids
 * painting it danger.
 */
export function resolveBackgroundTaskTerminalStatus(
  terminal: 'completed' | 'failed' | 'stopped',
): AgentActivityStatusV1 {
  switch (terminal) {
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'cancelled';
  }
}

/**
 * The CLI's binding of the protocol redactor to this machine's home directory.
 *
 * `redactBackgroundCommand` requires the collapse function rather than implementing one, because
 * home-directory handling has a canonical owner per layer; this is the CLI's
 * (`sessionHandoffPathNormalization.ts#toHomeRelativePath`, which owns the sibling-prefix rule).
 */
function redactForPersistence(value: string | null | undefined): string | undefined {
  const redacted = redactBackgroundCommand({
    command: value ?? null,
    collapseAbsolutePath: (absolutePath) => toHomeRelativePath({ absolutePath, homeDir: homedir() }),
  });
  return redacted.length > 0 ? redacted : undefined;
}

function toRecord(taskId: string, tracked: TrackedBackgroundTask): SessionBackgroundTaskRecordV1 {
  return {
    v: 1,
    taskId,
    kind: tracked.kind,
    status: tracked.status,
    ...(tracked.label !== undefined ? { label: tracked.label } : {}),
    ...(tracked.startedAt !== undefined ? { startedAt: tracked.startedAt } : {}),
    ...(tracked.endedAt !== undefined ? { endedAt: tracked.endedAt } : {}),
    ...(tracked.summary !== undefined ? { summary: tracked.summary } : {}),
    updatedAt: tracked.updatedAt,
  };
}

export function createBackgroundTaskRecordPublisher(params: Readonly<{
  /** Durable per-task record write, bound by the composition seam to the session + encryption. */
  commitRecord: (record: SessionBackgroundTaskRecordV1) => Promise<void>;
  /**
   * The provider ledger's ownership predicate (PLAN 4.9.1 step 2), so a foreign session's task
   * cannot be written into this session's durable history either. Read from the ledger rather than
   * re-derived: it owns the session LINEAGE, and a single "current" id would go stale at the first
   * compact boundary.
   */
  isOwnedSessionId?: (sessionId: string) => boolean;
  /** Latest-wins delay for progress-only updates. Terminal and start transitions bypass it. */
  debounceMs?: number;
  /**
   * `retryable: false` means the write was dropped and will never be attempted again from this
   * failure, so a caller cannot log "will retry" over a permanent rejection.
   */
  onError?: (error: unknown, context: Readonly<{ taskId: string; retryable: boolean }>) => void;
  now?: () => number;
}>): BackgroundTaskRecordPublisher {
  const now = params.now ?? Date.now;
  const debounceMs = params.debounceMs ?? 300;
  const tasks = new Map<string, TrackedBackgroundTask>();
  const dirtyTaskIds = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlightDrain: Promise<void> | null = null;
  let disposed = false;

  const clearDebounce = (): void => {
    if (debounceTimer === null) return;
    clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  /**
   * Commits every dirty task and RETURNS the ones worth another attempt; it never re-queues them
   * itself.
   */
  const runDrain = async (): Promise<readonly string[]> => {
    if (disposed || dirtyTaskIds.size === 0) return [];
    const draining = [...dirtyTaskIds];
    dirtyTaskIds.clear();
    const retryable: string[] = [];
    for (const taskId of draining) {
      const tracked = tasks.get(taskId);
      if (!tracked) continue;
      try {
        await params.commitRecord(toRecord(taskId, tracked));
      } catch (error) {
        // Isolate: only this task failed. The stable local id makes a later rewrite an in-place
        // replace, so re-committing from current state is idempotent rather than duplicating.
        //
        // A permanent rejection is dropped rather than re-queued: the server understood these
        // bytes and refused them, so the next attempt carries the same answer. The task stays
        // tracked, so genuinely NEW evidence (a progress line, a terminal status) still produces
        // one fresh attempt - the drop bounds the retry, not the task's own lifecycle.
        const shouldRetry = !isPermanentRequestError(error);
        params.onError?.(error, { taskId, retryable: shouldRetry });
        if (shouldRetry) retryable.push(taskId);
      }
    }
    return retryable;
  };

  /**
   * Drain owned by the scheduler: retryable failures come back as a debounced retry.
   *
   * `flush()` deliberately does NOT use this — retrying on a shutdown path would turn a persistently
   * failing write into a thousand synchronous attempts at the moment the session is closing.
   */
  const trackedDrain = (): Promise<void> => {
    const drain = runDrain().then((retryable) => {
      for (const taskId of retryable) scheduleRetry(taskId);
    });
    const tracked = drain.finally(() => {
      if (inFlightDrain === tracked) inFlightDrain = null;
    });
    inFlightDrain = tracked;
    return tracked;
  };

  const scheduler = createCoalescedScheduler({
    drain: trackedDrain,
    // A throw the per-task loop did not already classify (the scheduler itself, not one write).
    onError: (error) => params.onError?.(error, { taskId: '*', retryable: true }),
  });

  function scheduleDebounced(): void {
    if (disposed || debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scheduler.trigger();
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function scheduleRetry(taskId: string): void {
    if (disposed) return;
    dirtyTaskIds.add(taskId);
    scheduleDebounced();
  }

  function markDirty(taskId: string, immediate: boolean): void {
    if (disposed) return;
    dirtyTaskIds.add(taskId);
    if (!immediate) {
      scheduleDebounced();
      return;
    }
    clearDebounce();
    scheduler.trigger();
  }

  function observe(fact: ClaudeBackgroundTaskFact): void {
    if (disposed) return;
    if (params.isOwnedSessionId?.(fact.sessionId) === false) return;

    if (fact.type === 'started') {
      // Agent-flavoured and bookkeeping work never becomes a headless-command row. Classification
      // already happened at ingestion; this is the only gate that reads its answer.
      if (!isRecordedClaudeProviderTaskKind(fact.kind)) return;
      const observedAt = now();
      const existing = tasks.get(fact.taskId);
      const label = redactForPersistence(fact.label);
      tasks.set(fact.taskId, {
        ...(existing ?? {}),
        kind: fact.kind,
        // A late duplicate `task_started` must not resurrect a task that already reported terminal
        // evidence (PLAN 4.9.3: terminal status comes from evidence, and nothing un-terminals it).
        status: existing?.status ?? 'running',
        ...(label !== undefined ? { label } : {}),
        // No provider `start_time` exists on any SDK task message, so the first observation IS the
        // start. It is recorded once and never re-derived from an end instant (D-8).
        startedAt: existing?.startedAt ?? observedAt,
        updatedAt: observedAt,
      });
      markDirty(fact.taskId, true);
      return;
    }

    // Progress and terminal rows carry no `task_type`, so a task first seen at one of them has no
    // attested kind. Recording it as `unknown` would state a classification the provider never
    // gave; the row simply stays out until a `task_started` names it.
    const tracked = tasks.get(fact.taskId);
    if (!tracked) return;

    if (fact.type === 'progress') {
      const detail = redactForPersistence(fact.detail);
      tasks.set(fact.taskId, {
        ...tracked,
        ...(detail !== undefined ? { summary: detail } : {}),
        updatedAt: now(),
      });
      markDirty(fact.taskId, false);
      return;
    }

    const observedAt = now();
    const summary = redactForPersistence(fact.summary);
    tasks.set(fact.taskId, {
      ...tracked,
      status: resolveBackgroundTaskTerminalStatus(fact.status),
      endedAt: fact.endedAt ?? observedAt,
      ...(summary !== undefined ? { summary } : {}),
      updatedAt: observedAt,
    });
    markDirty(fact.taskId, true);
  }

  function finalizeOutstandingOnOrderlyStop(): void {
    if (disposed) return;
    for (const [taskId, tracked] of tasks) {
      if (isTerminalAgentActivityStatus(tracked.status)) continue;
      tasks.set(taskId, {
        ...tracked,
        status: 'cancelled',
        // The last instant we have evidence for. `endedAt` is when the work stopped being observed,
        // and the only observation we hold is `tracked.updatedAt`; `now()` would invent an end.
        endedAt: tracked.endedAt ?? tracked.updatedAt,
        updatedAt: now(),
      });
      // Immediate: this runs inside a teardown whose flush is already in progress behind it, and a
      // debounced write would be cancelled by the `dispose()` that follows.
      markDirty(taskId, true);
    }
  }

  async function flush(): Promise<void> {
    // Drain to quiescence: `markDirty` fires drains fire-and-forget, so awaiting once could return
    // while a terminal record is still in flight. Failures are NOT retried here (see `trackedDrain`),
    // which is what bounds this loop: every pass either lands its writes or drops them for the next
    // live drain, so it cannot spin on a persistently failing transport.
    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      if (disposed) return;
      clearDebounce();
      if (inFlightDrain) {
        await inFlightDrain;
        continue;
      }
      if (dirtyTaskIds.size === 0) return;
      await runDrain();
    }
  }

  function dispose(): void {
    disposed = true;
    clearDebounce();
    dirtyTaskIds.clear();
    scheduler.dispose();
  }

  return { observe, finalizeOutstandingOnOrderlyStop, flush, dispose };
}
