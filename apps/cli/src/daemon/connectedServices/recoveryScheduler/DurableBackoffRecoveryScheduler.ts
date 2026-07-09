import { sanitizeConnectedServiceDiagnosticString } from '../runtimeAuth/sanitizeConnectedServiceDiagnosticString';

type RecoveryStatus = 'waiting' | 'checking' | 'cancelled' | 'exhausted';

export type DurableBackoffRecoveryStore<TIntent> = Readonly<{
  read: (sessionId: string) => unknown | null;
  readAll?: () => ReadonlyArray<readonly [string, unknown]>;
  write: (sessionId: string, intent: TIntent) => Promise<void> | void;
  remove?: (sessionId: string) => Promise<void> | void;
  prune?: (predicate: (entry: Readonly<{ sessionId: string; value: unknown }>) => boolean) => Promise<ReadonlyArray<string>> | ReadonlyArray<string>;
}>;

export type DurableBackoffRecoveryResult<TIntent> =
  | Readonly<{ status: 'success'; intent?: TIntent; wakeResult?: Readonly<{ status: string } & Record<string, unknown>> }>
  | Readonly<{
      status: 'wait';
      nextRetryAtMs?: number | null;
      lastError?: string | null;
      intent?: TIntent;
      wakeResult?: Readonly<{ status: string } & Record<string, unknown>>;
    }>
  | Readonly<{ status: 'terminal'; lastError?: string | null; intent?: TIntent; wakeResult?: Readonly<{ status: string } & Record<string, unknown>> }>
  | Readonly<{ status: 'exhausted'; lastError?: string | null; intent?: TIntent; wakeResult?: Readonly<{ status: string } & Record<string, unknown>> }>
  // The recovery no longer applies (the condition it was armed for was superseded by other
  // progress — e.g. the group already switched off the failing profile). The record is
  // REMOVED, never terminalized: a terminal record would block re-arming the same key on a
  // genuine future failure.
  | Readonly<{ status: 'superseded'; reason?: string | null; wakeResult?: Readonly<{ status: string } & Record<string, unknown>> }>;

export type DurableRecoveryGateResult =
  | Readonly<{ status: 'open' }>
  | Readonly<{ status: 'delayed'; retryAtMs: number; reason: string }>;

type TimerHandle = ReturnType<typeof setTimeout>;

// Node setTimeout treats delays above 2^31-1 ms (~24.8 days) as overflowed and fires
// them immediately. Long durable waits (wait-until-reset intents) must be chunked:
// arm at most this delay and re-arm on each early fire until the real wake time.
const MAX_SAFE_TIMER_DELAY_MS = 2_147_483_647;

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function sanitizeLastError(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  return sanitizeConnectedServiceDiagnosticString(trimmed);
}

function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return sanitizeLastError(error.message);
  if (typeof error === 'string' && error.trim()) return sanitizeLastError(error);
  return null;
}

export class DurableBackoffRecoveryScheduler<TIntent> {
  #disposed = false;
  readonly #intentsBySessionId = new Map<string, TIntent>();
  readonly #timersBySessionId = new Map<string, TimerHandle>();
  readonly #wakePromisesBySessionId = new Map<string, Promise<Readonly<{ status: string }>>>();
  readonly #intentVersionsBySessionId = new Map<string, number>();
  readonly #nowMs: () => number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #jitterMs: () => number;
  readonly #store: DurableBackoffRecoveryStore<TIntent> | null;
  readonly #normalizeIntent: (value: unknown) => TIntent | null;
  readonly #getStatus: (intent: TIntent) => RecoveryStatus;
  readonly #getNextRetryAtMs: (intent: TIntent) => number | null;
  readonly #getAttemptCount: (intent: TIntent) => number;
  readonly #getMaxAttempts: (intent: TIntent) => number;
  readonly #terminalRecordRetentionMs: number | null;
  readonly #getTerminalPruneReferenceMs: ((intent: TIntent) => number | null) | null;
  readonly #markChecking: (intent: TIntent, attemptCount: number) => TIntent;
  readonly #markWaiting: (intent: TIntent, input: { nextRetryAtMs: number; lastError: string | null }) => TIntent;
  readonly #markCancelled: (intent: TIntent) => TIntent;
  readonly #markExhausted: (intent: TIntent, input: { lastError: string | null }) => TIntent;
  readonly #recover: (intent: TIntent, context: { sessionId: string; reason: string }) => Promise<DurableBackoffRecoveryResult<TIntent>>;
  readonly #gate: ((input: { sessionId: string; intent: TIntent }) => DurableRecoveryGateResult) | null;
  readonly #onSuccess: ((input: { sessionId: string; intent: TIntent }) => Promise<void> | void) | null;
  readonly #clearOnSuccess: boolean;
  readonly #onDelayed: ((input: { sessionId: string; intent: TIntent; retryAtMs: number; reason: string }) => void) | null;
  readonly #onExhausted: ((input: { sessionId: string; intent: TIntent; lastError: string | null }) => void) | null;
  readonly #onSuperseded: ((input: { sessionId: string; intent: TIntent; reason: string | null }) => void) | null;
  readonly #exhaustAfterWait: boolean;
  readonly #honorTimerNotBefore: boolean;

  constructor(deps: Readonly<{
    nowMs: () => number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    jitterMs?: () => number;
    store?: DurableBackoffRecoveryStore<TIntent>;
    normalizeIntent: (value: unknown) => TIntent | null;
    getStatus: (intent: TIntent) => RecoveryStatus;
    getNextRetryAtMs: (intent: TIntent) => number | null;
    getAttemptCount: (intent: TIntent) => number;
    getMaxAttempts: (intent: TIntent) => number;
    terminalRecordRetentionMs?: number;
    getTerminalPruneReferenceMs?: (intent: TIntent) => number | null;
    markChecking: (intent: TIntent, attemptCount: number) => TIntent;
    markWaiting: (intent: TIntent, input: { nextRetryAtMs: number; lastError: string | null }) => TIntent;
    markCancelled: (intent: TIntent) => TIntent;
    markExhausted: (intent: TIntent, input: { lastError: string | null }) => TIntent;
    recover: (intent: TIntent, context: { sessionId: string; reason: string }) => Promise<DurableBackoffRecoveryResult<TIntent>>;
    gate?: (input: { sessionId: string; intent: TIntent }) => DurableRecoveryGateResult;
    onSuccess?: (input: { sessionId: string; intent: TIntent }) => Promise<void> | void;
    clearOnSuccess?: boolean;
    onDelayed?: (input: { sessionId: string; intent: TIntent; retryAtMs: number; reason: string }) => void;
    onExhausted?: (input: { sessionId: string; intent: TIntent; lastError: string | null }) => void;
    onSuperseded?: (input: { sessionId: string; intent: TIntent; reason: string | null }) => void;
    exhaustAfterWait?: boolean;
    honorTimerNotBefore?: boolean;
  }>) {
    this.#nowMs = deps.nowMs;
    this.#baseBackoffMs = clampPositiveInteger(deps.baseBackoffMs, 1_000);
    this.#maxBackoffMs = Math.max(
      this.#baseBackoffMs,
      clampPositiveInteger(deps.maxBackoffMs, 60_000),
    );
    this.#jitterMs = deps.jitterMs ?? (() => 0);
    this.#store = deps.store ?? null;
    this.#normalizeIntent = deps.normalizeIntent;
    this.#getStatus = deps.getStatus;
    this.#getNextRetryAtMs = deps.getNextRetryAtMs;
    this.#getAttemptCount = deps.getAttemptCount;
    this.#getMaxAttempts = deps.getMaxAttempts;
    this.#terminalRecordRetentionMs = typeof deps.terminalRecordRetentionMs === 'number' && Number.isFinite(deps.terminalRecordRetentionMs)
      ? Math.max(0, Math.trunc(deps.terminalRecordRetentionMs))
      : null;
    this.#getTerminalPruneReferenceMs = deps.getTerminalPruneReferenceMs ?? null;
    this.#markChecking = deps.markChecking;
    this.#markWaiting = deps.markWaiting;
    this.#markCancelled = deps.markCancelled;
    this.#markExhausted = deps.markExhausted;
    this.#recover = deps.recover;
    this.#gate = deps.gate ?? null;
    this.#onSuccess = deps.onSuccess ?? null;
    this.#clearOnSuccess = deps.clearOnSuccess ?? false;
    this.#onDelayed = deps.onDelayed ?? null;
    this.#onExhausted = deps.onExhausted ?? null;
    this.#onSuperseded = deps.onSuperseded ?? null;
    this.#exhaustAfterWait = deps.exhaustAfterWait ?? true;
    this.#honorTimerNotBefore = deps.honorTimerNotBefore ?? false;
  }

  async upsert(input: Readonly<{ sessionId: string; intent: TIntent }>): Promise<TIntent> {
    await this.#write(input.sessionId, input.intent);
    return input.intent;
  }

  load(input: Readonly<{ sessionId: string; intent: TIntent }>): TIntent {
    this.#intentVersionsBySessionId.set(input.sessionId, (this.#intentVersionsBySessionId.get(input.sessionId) ?? 0) + 1);
    this.#intentsBySessionId.set(input.sessionId, input.intent);
    this.#schedule(input.sessionId, input.intent);
    return input.intent;
  }

  async upsertMerged(input: Readonly<{
    sessionId: string;
    intent: TIntent;
    merge: (previous: TIntent | null, next: TIntent) => TIntent;
  }>): Promise<TIntent> {
    const previous = this.read(input.sessionId);
    const merged = input.merge(previous, input.intent);
    if (previous && Object.is(previous, merged)) return merged;
    await this.#write(input.sessionId, merged);
    return merged;
  }

  read(sessionId: string): TIntent | null {
    const cached = this.#intentsBySessionId.get(sessionId);
    if (cached) return cached;
    const stored = this.#store?.read(sessionId) ?? null;
    const normalized = this.#normalizeIntent(stored);
    if (!normalized) return null;
    this.#intentsBySessionId.set(sessionId, normalized);
    this.#schedule(sessionId, normalized);
    return normalized;
  }

  hydrate(): ReadonlyArray<TIntent> {
    const stored = this.#store?.readAll?.() ?? [];
    const hydrated: TIntent[] = [];
    for (const [sessionId, value] of stored) {
      const normalized = this.#normalizeIntent(value);
      if (!normalized) continue;
      this.#intentsBySessionId.set(sessionId, normalized);
      this.#schedule(sessionId, normalized);
      hydrated.push(normalized);
    }
    return hydrated;
  }

  async cancel(input: Readonly<{ sessionId: string }>): Promise<TIntent | null> {
    const current = this.read(input.sessionId);
    if (!current) return null;
    const cancelled = this.#markCancelled(current);
    await this.#write(input.sessionId, cancelled);
    this.#clearTimer(input.sessionId);
    return cancelled;
  }

  async clear(input: Readonly<{ sessionId: string }>): Promise<TIntent | null> {
    const current = this.read(input.sessionId);
    if (!current) return null;
    await this.#remove(input.sessionId);
    this.#clearTimer(input.sessionId);
    return current;
  }

  async pruneTerminalRecords(): Promise<ReadonlyArray<string>> {
    if (this.#terminalRecordRetentionMs === null || !this.#getTerminalPruneReferenceMs) return [];
    const cutoffMs = this.#nowMs() - this.#terminalRecordRetentionMs;
    const shouldPrune = (value: unknown): boolean => {
      const intent = this.#normalizeIntent(value);
      if (!intent) return false;
      const status = this.#getStatus(intent);
      if (status !== 'cancelled' && status !== 'exhausted') return false;
      const referenceMs = this.#getTerminalPruneReferenceMs?.(intent);
      return typeof referenceMs === 'number' && Number.isFinite(referenceMs) && referenceMs <= cutoffMs;
    };
    const prunedSessionIds = this.#store?.prune
      ? await this.#store.prune(({ value }) => shouldPrune(value))
      : await this.#pruneTerminalRecordsWithRemove(shouldPrune);
    for (const sessionId of prunedSessionIds) {
      this.#intentsBySessionId.delete(sessionId);
      this.#clearTimer(sessionId);
    }
    return prunedSessionIds;
  }

  /**
   * Stop all armed timers and short-circuit further scheduling/wakes. Called from the daemon
   * shutdown path so recovery timers cannot fire switch/restart work into a tearing-down daemon.
   * Any optional store is left untouched; caller wiring decides whether those records outlive the
   * process.
   */
  dispose(): void {
    this.#disposed = true;
    for (const sessionId of [...this.#timersBySessionId.keys()]) {
      this.#clearTimer(sessionId);
    }
  }

  async wake(input: Readonly<{ sessionId: string; reason: string }>): Promise<Readonly<{ status: string }>> {
    if (this.#disposed) return { status: 'disposed' };
    const existingWake = this.#wakePromisesBySessionId.get(input.sessionId);
    if (existingWake) return await existingWake;
    const wakePromise = this.#performWake(input);
    this.#wakePromisesBySessionId.set(input.sessionId, wakePromise);
    try {
      return await wakePromise;
    } finally {
      if (this.#wakePromisesBySessionId.get(input.sessionId) === wakePromise) {
        this.#wakePromisesBySessionId.delete(input.sessionId);
      }
    }
  }

  async #performWake(input: Readonly<{ sessionId: string; reason: string }>): Promise<Readonly<{ status: string }>> {
    const current = this.read(input.sessionId);
    if (!current || this.#getStatus(current) === 'cancelled') return { status: 'inactive' };
    if (this.#getStatus(current) === 'exhausted') return { status: 'exhausted' };

    const nowMs = this.#nowMs();
    const nextRetryAtMs = this.#getNextRetryAtMs(current);
    if (this.#honorTimerNotBefore && input.reason === 'timer' && nextRetryAtMs !== null && nowMs < nextRetryAtMs) {
      // The firing timer already removed itself: re-arm for the remaining wait so an
      // early fire (int32 clamp chunking, wall clock moved backward) cannot silently
      // drop the intent's wake-up.
      this.#schedule(input.sessionId, current);
      return { status: 'waiting' };
    }

    const gate = this.#gate?.({ sessionId: input.sessionId, intent: current }) ?? { status: 'open' as const };
    if (gate.status === 'delayed') {
      const reason = sanitizeConnectedServiceDiagnosticString(gate.reason);
      const delayed = this.#markWaiting(current, {
        nextRetryAtMs: gate.retryAtMs,
        lastError: sanitizeLastError(reason),
      });
      await this.#write(input.sessionId, delayed);
      this.#onDelayed?.({
        sessionId: input.sessionId,
        intent: delayed,
        retryAtMs: gate.retryAtMs,
        reason,
      });
      return { status: 'waiting' };
    }

    const nextAttemptCount = this.#getAttemptCount(current) + 1;
    const maxAttempts = this.#getMaxAttempts(current);
    if (maxAttempts > 0 && this.#getAttemptCount(current) >= maxAttempts) {
      const exhaustedBase = this.#markChecking(current, nextAttemptCount);
      const exhausted = this.#markExhausted(exhaustedBase, { lastError: 'max_attempts_exhausted' });
      await this.#write(input.sessionId, exhausted);
      this.#clearTimer(input.sessionId);
      this.#onExhausted?.({
        sessionId: input.sessionId,
        intent: exhausted,
        lastError: 'max_attempts_exhausted',
      });
      return { status: 'exhausted' };
    }

    const checking = this.#markChecking(current, nextAttemptCount);
    await this.#write(input.sessionId, checking);
    const recoveryStartedVersion = this.#intentVersionsBySessionId.get(input.sessionId) ?? 0;

    const recovery = await this.#recover(checking, {
      sessionId: input.sessionId,
      reason: input.reason,
    }).catch((error: unknown): DurableBackoffRecoveryResult<TIntent> => ({
      status: 'wait',
      lastError: readErrorMessage(error),
    }));

    if ((this.#intentVersionsBySessionId.get(input.sessionId) ?? 0) !== recoveryStartedVersion) {
      return { status: 'inactive' };
    }

    if (recovery.status === 'success') {
      const succeeded = recovery.intent ?? checking;
      if (this.#clearOnSuccess && this.#getStatus(succeeded) !== 'cancelled' && this.#getStatus(succeeded) !== 'exhausted') {
        await this.#remove(input.sessionId);
        this.#clearTimer(input.sessionId);
        await this.#onSuccess?.({ sessionId: input.sessionId, intent: succeeded });
        return recovery.wakeResult ?? { status: 'succeeded' };
      }
      const cancelled = this.#markCancelled(succeeded);
      await this.#write(input.sessionId, cancelled);
      this.#clearTimer(input.sessionId);
      await this.#onSuccess?.({ sessionId: input.sessionId, intent: cancelled });
      return recovery.wakeResult ?? { status: 'succeeded' };
    }

    if (recovery.status === 'superseded') {
      await this.#remove(input.sessionId);
      this.#clearTimer(input.sessionId);
      this.#onSuperseded?.({
        sessionId: input.sessionId,
        intent: checking,
        reason: sanitizeLastError(recovery.reason),
      });
      return recovery.wakeResult ?? { status: 'superseded' };
    }

    if (recovery.status === 'terminal') {
      const terminal = recovery.intent ?? checking;
      const cancelled = this.#markCancelled(terminal);
      await this.#write(input.sessionId, cancelled);
      this.#clearTimer(input.sessionId);
      return recovery.wakeResult ?? { status: 'terminal' };
    }

    if (recovery.status === 'exhausted') {
      const lastError = sanitizeLastError(recovery.lastError);
      const exhausted = this.#markExhausted(recovery.intent ?? checking, {
        lastError,
      });
      await this.#write(input.sessionId, exhausted);
      this.#clearTimer(input.sessionId);
      this.#onExhausted?.({
        sessionId: input.sessionId,
        intent: exhausted,
        lastError,
      });
      return recovery.wakeResult ?? { status: 'exhausted' };
    }

    // Honor an outcome-provided intent's attempt count: recover loops may roll the
    // markChecking increment back for outcomes that must not consume the attempt
    // budget (degraded local outages, durable group-exhausted waits). Exhaustion
    // must respect that rollback, or a durable wait reached AT the ceiling still
    // dead-letters even though the recover loop asked to keep waiting (F0).
    const settledAttemptCount = recovery.intent === undefined
      ? nextAttemptCount
      : this.#getAttemptCount(recovery.intent);
    if (this.#exhaustAfterWait && maxAttempts > 0 && settledAttemptCount >= maxAttempts) {
      const lastError = sanitizeLastError(recovery.lastError);
      const exhausted = this.#markExhausted(recovery.intent ?? checking, {
        lastError,
      });
      await this.#write(input.sessionId, exhausted);
      this.#clearTimer(input.sessionId);
      this.#onExhausted?.({
        sessionId: input.sessionId,
        intent: exhausted,
        lastError,
      });
      return recovery.wakeResult ?? { status: 'exhausted' };
    }

    const waitBase = recovery.intent ?? checking;
    const retryAtMs = recovery.nextRetryAtMs ?? this.#resolveNextRetryAtMs(nextAttemptCount);
    const waiting = this.#markWaiting(waitBase, {
      nextRetryAtMs: retryAtMs,
      lastError: sanitizeLastError(recovery.lastError),
    });
    await this.#write(input.sessionId, waiting);
    return recovery.wakeResult ?? { status: 'waiting' };
  }

  #resolveNextRetryAtMs(attemptCount: number): number {
    const delayMs = Math.min(
      this.#maxBackoffMs,
      this.#baseBackoffMs * (2 ** attemptCount),
    );
    const jitterMs = Math.max(0, Math.floor(this.#jitterMs()));
    return this.#nowMs() + delayMs + jitterMs;
  }

  async #write(sessionId: string, intent: TIntent): Promise<void> {
    await this.pruneTerminalRecords();
    this.#intentVersionsBySessionId.set(sessionId, (this.#intentVersionsBySessionId.get(sessionId) ?? 0) + 1);
    this.#intentsBySessionId.set(sessionId, intent);
    await this.#store?.write(sessionId, intent);
    this.#schedule(sessionId, intent);
  }

  async #remove(sessionId: string): Promise<void> {
    this.#intentVersionsBySessionId.set(sessionId, (this.#intentVersionsBySessionId.get(sessionId) ?? 0) + 1);
    this.#intentsBySessionId.delete(sessionId);
    await this.#store?.remove?.(sessionId);
  }

  async #pruneTerminalRecordsWithRemove(
    predicate: (value: unknown) => boolean,
  ): Promise<ReadonlyArray<string>> {
    if (!this.#store?.readAll || !this.#store.remove) return [];
    const prunedSessionIds: string[] = [];
    for (const [sessionId, value] of this.#store.readAll()) {
      if (!predicate(value)) continue;
      await this.#store.remove(sessionId);
      prunedSessionIds.push(sessionId);
    }
    return prunedSessionIds;
  }

  #schedule(sessionId: string, intent: TIntent): void {
    this.#clearTimer(sessionId);
    if (this.#disposed) return;
    if (this.#getStatus(intent) !== 'waiting') return;
    const nextRetryAtMs = this.#getNextRetryAtMs(intent);
    if (nextRetryAtMs === null || !Number.isFinite(nextRetryAtMs)) return;
    const delayMs = Math.min(MAX_SAFE_TIMER_DELAY_MS, Math.max(0, nextRetryAtMs - this.#nowMs()));
    const timer = setTimeout(() => {
      this.#timersBySessionId.delete(sessionId);
      void this.wake({ sessionId, reason: 'timer' });
    }, delayMs);
    timer.unref?.();
    this.#timersBySessionId.set(sessionId, timer);
  }

  #clearTimer(sessionId: string): void {
    const timer = this.#timersBySessionId.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.#timersBySessionId.delete(sessionId);
  }
}
