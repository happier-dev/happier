import { randomUUID } from 'node:crypto';

import { sanitizeConnectedServiceDiagnosticString } from '../runtimeAuth/sanitizeConnectedServiceDiagnosticString';

type RecoveryStatus = 'waiting' | 'checking' | 'cancelled' | 'exhausted';

export type DurableBackoffRecoveryStore<TIntent> = Readonly<{
  read: (sessionId: string) => unknown | null;
  readAuthoritative?: (sessionId: string) => unknown | null;
  readAll?: () => ReadonlyArray<readonly [string, unknown]>;
  write: (sessionId: string, intent: TIntent) => Promise<void> | void;
  remove?: (sessionId: string) => Promise<void> | void;
  prune?: (predicate: (entry: Readonly<{ sessionId: string; value: unknown }>) => boolean) => Promise<ReadonlyArray<string>> | ReadonlyArray<string>;
  transact?: <TResult>(
    sessionId: string,
    transaction: (current: Readonly<{
      intent: TIntent | null;
      effectClaimToken: string | null;
    }>) => Readonly<{
      intent: TIntent | null;
      effectClaimToken: string | null;
      result: TResult;
    }>,
  ) => Promise<TResult>;
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

type DurableWakePreparation<TIntent> =
  | Readonly<{ status: 'inactive' }>
  | Readonly<{ status: 'cancelled' }>
  | Readonly<{ status: 'already_exhausted' }>
  | Readonly<{ status: 'checking' }>
  | Readonly<{ status: 'delayed'; intent: TIntent; retryAtMs: number; reason: string }>
  | Readonly<{ status: 'exhausted'; intent: TIntent }>
  | Readonly<{ status: 'claimed'; intent: TIntent; effectClaimToken: string }>;

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
  readonly #isSameIntentVersion: (left: TIntent, right: TIntent) => boolean;
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
    isSameIntentVersion?: (left: TIntent, right: TIntent) => boolean;
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
    this.#isSameIntentVersion = deps.isSameIntentVersion
      ?? ((left, right) => JSON.stringify(left) === JSON.stringify(right));
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
    return await this.transact({
      sessionId: input.sessionId,
      transaction: (current) => {
        const previous = this.#normalizeIntent(current);
        const merged = input.merge(previous, input.intent);
        // Preserve the transaction input identity for semantic no-ops. This prevents
        // duplicate reports from fencing an already-running recovery, while a genuinely
        // different replacement object still advances the settlement epoch.
        return { intent: previous !== null && merged === previous ? current : merged, result: merged };
      },
    });
  }

  async transact<TResult>(input: Readonly<{
    sessionId: string;
    transaction: (current: TIntent | null) => Readonly<{ intent: TIntent | null; result: TResult }>;
    schedule?: boolean;
  }>): Promise<TResult> {
    let nextIntent: TIntent | null = null;
    let changed = true;
    const run = (current: TIntent | null) => {
      const next = input.transaction(current);
      nextIntent = next.intent;
      changed = next.intent !== current;
      return next;
    };
    if (!this.#store?.transact) {
      const current = this.read(input.sessionId, { schedule: input.schedule });
      const next = run(current);
      if (!changed) return next.result;
      if (next.intent === null) {
        await this.#remove(input.sessionId);
        this.#clearTimer(input.sessionId);
      } else {
        await this.#write(input.sessionId, next.intent, { schedule: input.schedule });
      }
      return next.result;
    }
    const result = await this.#store.transact(input.sessionId, (current) => {
      const next = run(current.intent);
      return {
        ...next,
        effectClaimToken: current.effectClaimToken,
      };
    });
    if (!changed) return result;
    const durableCurrent = this.#store.readAuthoritative
      ? this.#normalizeIntent(this.#store.readAuthoritative(input.sessionId))
      : nextIntent;
    this.#intentVersionsBySessionId.set(input.sessionId, (this.#intentVersionsBySessionId.get(input.sessionId) ?? 0) + 1);
    if (durableCurrent === null) {
      this.#intentsBySessionId.delete(input.sessionId);
      this.#clearTimer(input.sessionId);
    } else {
      this.#intentsBySessionId.set(input.sessionId, durableCurrent);
      if (input.schedule !== false) this.#schedule(input.sessionId, durableCurrent);
    }
    return result;
  }

  read(
    sessionId: string,
    options: Readonly<{ schedule?: boolean }> = {},
  ): TIntent | null {
    const cached = this.#intentsBySessionId.get(sessionId);
    const stored = this.#store?.readAuthoritative
      ? this.#store.readAuthoritative(sessionId)
      : cached ?? this.#store?.read(sessionId) ?? null;
    const normalized = this.#normalizeIntent(stored);
    if (!normalized) {
      this.#intentsBySessionId.delete(sessionId);
      this.#clearTimer(sessionId);
      return null;
    }
    this.#intentsBySessionId.set(sessionId, normalized);
    if (options.schedule !== false) this.#schedule(sessionId, normalized);
    return normalized;
  }

  hydrate(options: Readonly<{ schedule?: boolean }> = {}): ReadonlyArray<TIntent> {
    const stored = this.#store?.readAll?.() ?? [];
    const hydrated: TIntent[] = [];
    for (const [sessionId, value] of stored) {
      const normalized = this.#normalizeIntent(value);
      if (!normalized) continue;
      this.#intentsBySessionId.set(sessionId, normalized);
      if (options.schedule !== false) {
        this.#schedule(sessionId, normalized);
      }
      hydrated.push(normalized);
    }
    return hydrated;
  }

  async cancel(input: Readonly<{ sessionId: string }>): Promise<TIntent | null> {
    if (this.#store?.transact) {
      const cancelled = await this.#store.transact(input.sessionId, (current) => {
        const intent = current.intent === null ? null : this.#normalizeIntent(current.intent);
        const next = intent ? this.#markCancelled(intent) : null;
        return {
          intent: next,
          effectClaimToken: null,
          result: next,
        };
      });
      this.#intentVersionsBySessionId.set(
        input.sessionId,
        (this.#intentVersionsBySessionId.get(input.sessionId) ?? 0) + 1,
      );
      if (!cancelled) {
        this.#intentsBySessionId.delete(input.sessionId);
        this.#clearTimer(input.sessionId);
        return null;
      }
      this.#intentsBySessionId.set(input.sessionId, cancelled);
      this.#clearTimer(input.sessionId);
      return cancelled;
    }
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

  /**
   * A durable effect claim has no time-based expiry: a slow live owner may overlap a
   * replacement process. Only a fresh user action, after the caller has independently
   * confirmed that owner is gone, may rearm the recovery.
   */
  async rearmAfterConfirmedEffectOwnerLoss(input: Readonly<{
    sessionId: string;
    authorization: 'fresh_user_action_after_owner_loss';
  }>): Promise<TIntent | null> {
    if (!this.#store?.transact) return this.read(input.sessionId);
    const rearmed = await this.#store.transact(input.sessionId, (current) => {
      const intent = current.intent === null ? null : this.#normalizeIntent(current.intent);
      if (!intent || current.effectClaimToken === null) {
        return {
          intent,
          effectClaimToken: current.effectClaimToken,
          result: intent,
        };
      }
      const status = this.#getStatus(intent);
      if (status === 'cancelled' || status === 'exhausted') {
        return {
          intent,
          effectClaimToken: null,
          result: intent,
        };
      }
      const next = this.#markWaiting(intent, {
        nextRetryAtMs: this.#resolveNextRetryAtMs(this.#getAttemptCount(intent)),
        lastError: 'recovery_effect_owner_lost',
      });
      return {
        intent: next,
        effectClaimToken: null,
        result: next,
      };
    });
    this.#intentVersionsBySessionId.set(
      input.sessionId,
      (this.#intentVersionsBySessionId.get(input.sessionId) ?? 0) + 1,
    );
    if (!rearmed) {
      this.#intentsBySessionId.delete(input.sessionId);
      this.#clearTimer(input.sessionId);
      return null;
    }
    this.#intentsBySessionId.set(input.sessionId, rearmed);
    this.#schedule(input.sessionId, rearmed);
    return rearmed;
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

    const effectClaimToken = randomUUID();
    const durablePreparation = this.#store?.transact
      ? await this.#store.transact<DurableWakePreparation<TIntent>>(input.sessionId, (stored) => {
        const durableIntent = stored.intent === null ? null : this.#normalizeIntent(stored.intent);
        if (!durableIntent) {
          return {
            intent: null,
            effectClaimToken: null,
            result: { status: 'inactive' as const },
          };
        }
        const durableStatus = this.#getStatus(durableIntent);
        if (durableStatus === 'cancelled' || durableStatus === 'exhausted') {
          return {
            intent: durableIntent,
            effectClaimToken: null,
            result: {
              status: durableStatus === 'cancelled'
                ? 'cancelled' as const
                : 'already_exhausted' as const,
            },
          };
        }
        if (stored.effectClaimToken !== null) {
          return {
            intent: durableIntent,
            effectClaimToken: stored.effectClaimToken,
            result: { status: 'checking' as const },
          };
        }
        const durableGate = this.#gate?.({
          sessionId: input.sessionId,
          intent: durableIntent,
        }) ?? { status: 'open' as const };
        if (durableGate.status === 'delayed') {
          const reason = sanitizeConnectedServiceDiagnosticString(durableGate.reason);
          const delayed = this.#markWaiting(durableIntent, {
            nextRetryAtMs: durableGate.retryAtMs,
            lastError: sanitizeLastError(reason),
          });
          return {
            intent: delayed,
            effectClaimToken: null,
            result: {
              status: 'delayed' as const,
              intent: delayed,
              retryAtMs: durableGate.retryAtMs,
              reason,
            },
          };
        }
        const nextAttemptCount = this.#getAttemptCount(durableIntent) + 1;
        const maxAttempts = this.#getMaxAttempts(durableIntent);
        if (maxAttempts > 0 && this.#getAttemptCount(durableIntent) >= maxAttempts) {
          const exhaustedBase = this.#markChecking(durableIntent, nextAttemptCount);
          const exhausted = this.#markExhausted(exhaustedBase, { lastError: 'max_attempts_exhausted' });
          return {
            intent: exhausted,
            effectClaimToken: null,
            result: { status: 'exhausted' as const, intent: exhausted },
          };
        }
        const checking = this.#markChecking(durableIntent, nextAttemptCount);
        return {
          intent: checking,
          effectClaimToken,
          result: {
            status: 'claimed' as const,
            intent: checking,
            effectClaimToken,
          },
        };
      })
      : null;

    if (durablePreparation) {
      if (durablePreparation.status === 'inactive' || durablePreparation.status === 'cancelled') {
        this.#intentsBySessionId.delete(input.sessionId);
        this.#clearTimer(input.sessionId);
        return { status: 'inactive' };
      }
      if (durablePreparation.status === 'already_exhausted') {
        this.#clearTimer(input.sessionId);
        return { status: 'exhausted' };
      }
      if (durablePreparation.status === 'checking') {
        this.#clearTimer(input.sessionId);
        return { status: 'checking' };
      }
      this.#intentVersionsBySessionId.set(
        input.sessionId,
        (this.#intentVersionsBySessionId.get(input.sessionId) ?? 0) + 1,
      );
      this.#intentsBySessionId.set(input.sessionId, durablePreparation.intent);
      if (durablePreparation.status === 'delayed') {
        this.#schedule(input.sessionId, durablePreparation.intent);
        this.#onDelayed?.({
          sessionId: input.sessionId,
          intent: durablePreparation.intent,
          retryAtMs: durablePreparation.retryAtMs,
          reason: durablePreparation.reason,
        });
        return { status: 'waiting' };
      }
      if (durablePreparation.status === 'exhausted') {
        this.#clearTimer(input.sessionId);
        this.#onExhausted?.({
          sessionId: input.sessionId,
          intent: durablePreparation.intent,
          lastError: 'max_attempts_exhausted',
        });
        return { status: 'exhausted' };
      }
    }

    let checking: TIntent;
    if (durablePreparation?.status === 'claimed') {
      checking = durablePreparation.intent;
    } else {
      const gate = this.#gate?.({ sessionId: input.sessionId, intent: current }) ?? { status: 'open' as const };
      if (gate.status === 'delayed') {
        const reason = sanitizeConnectedServiceDiagnosticString(gate.reason);
        const delayed = this.#markWaiting(current, {
          nextRetryAtMs: gate.retryAtMs,
          lastError: sanitizeLastError(reason),
        });
        if (!await this.#replaceIfCurrent(input.sessionId, current, delayed)) return { status: 'inactive' };
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
        if (!await this.#replaceIfCurrent(input.sessionId, current, exhausted)) return { status: 'inactive' };
        this.#clearTimer(input.sessionId);
        this.#onExhausted?.({
          sessionId: input.sessionId,
          intent: exhausted,
          lastError: 'max_attempts_exhausted',
        });
        return { status: 'exhausted' };
      }

      checking = this.#markChecking(current, nextAttemptCount);
      if (!await this.#replaceIfCurrent(input.sessionId, current, checking)) return { status: 'inactive' };
    }
    const recoveryStartedVersion = this.#intentVersionsBySessionId.get(input.sessionId) ?? 0;
    const nextAttemptCount = this.#getAttemptCount(checking);
    const maxAttempts = this.#getMaxAttempts(checking);

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
        if (!await this.#replaceIfCurrent(input.sessionId, checking, null, effectClaimToken)) return { status: 'inactive' };
        this.#clearTimer(input.sessionId);
        await this.#onSuccess?.({ sessionId: input.sessionId, intent: succeeded });
        return recovery.wakeResult ?? { status: 'succeeded' };
      }
      const cancelled = this.#markCancelled(succeeded);
      if (!await this.#replaceIfCurrent(input.sessionId, checking, cancelled, effectClaimToken)) return { status: 'inactive' };
      this.#clearTimer(input.sessionId);
      await this.#onSuccess?.({ sessionId: input.sessionId, intent: cancelled });
      return recovery.wakeResult ?? { status: 'succeeded' };
    }

    if (recovery.status === 'superseded') {
      if (!await this.#replaceIfCurrent(input.sessionId, checking, null, effectClaimToken)) return { status: 'inactive' };
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
      if (!await this.#replaceIfCurrent(input.sessionId, checking, cancelled, effectClaimToken)) return { status: 'inactive' };
      this.#clearTimer(input.sessionId);
      return recovery.wakeResult ?? { status: 'terminal' };
    }

    if (recovery.status === 'exhausted') {
      const lastError = sanitizeLastError(recovery.lastError);
      const exhausted = this.#markExhausted(recovery.intent ?? checking, {
        lastError,
      });
      if (!await this.#replaceIfCurrent(input.sessionId, checking, exhausted, effectClaimToken)) return { status: 'inactive' };
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
      if (!await this.#replaceIfCurrent(input.sessionId, checking, exhausted, effectClaimToken)) return { status: 'inactive' };
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
    if (!await this.#replaceIfCurrent(input.sessionId, checking, waiting, effectClaimToken)) return { status: 'inactive' };
    return recovery.wakeResult ?? { status: 'waiting' };
  }

  async #replaceIfCurrent(
    sessionId: string,
    expected: TIntent,
    replacement: TIntent | null,
    effectClaimToken?: string,
  ): Promise<boolean> {
    if (effectClaimToken && this.#store?.transact) {
      const settled = await this.#store.transact(sessionId, (current) => {
        const intent = current.intent === null ? null : this.#normalizeIntent(current.intent);
        if (
          !intent
          || current.effectClaimToken !== effectClaimToken
          || !this.#isSameIntentVersion(intent, expected)
        ) {
          return {
            intent,
            effectClaimToken: current.effectClaimToken,
            result: false,
          };
        }
        return {
          intent: replacement,
          effectClaimToken: null,
          result: true,
        };
      });
      if (!settled) return false;
      this.#intentVersionsBySessionId.set(
        sessionId,
        (this.#intentVersionsBySessionId.get(sessionId) ?? 0) + 1,
      );
      if (replacement === null) {
        this.#intentsBySessionId.delete(sessionId);
        this.#clearTimer(sessionId);
      } else {
        this.#intentsBySessionId.set(sessionId, replacement);
        this.#schedule(sessionId, replacement);
      }
      return true;
    }
    return await this.transact({
      sessionId,
      transaction: (current) => {
        if (!current || !this.#isSameIntentVersion(current, expected)) {
          return { intent: current, result: false };
        }
        return { intent: replacement, result: true };
      },
    });
  }

  #resolveNextRetryAtMs(attemptCount: number): number {
    const delayMs = Math.min(
      this.#maxBackoffMs,
      this.#baseBackoffMs * (2 ** attemptCount),
    );
    const jitterMs = Math.max(0, Math.floor(this.#jitterMs()));
    return this.#nowMs() + delayMs + jitterMs;
  }

  async #write(
    sessionId: string,
    intent: TIntent,
    options: Readonly<{ schedule?: boolean }> = {},
  ): Promise<void> {
    await this.pruneTerminalRecords();
    this.#intentVersionsBySessionId.set(sessionId, (this.#intentVersionsBySessionId.get(sessionId) ?? 0) + 1);
    this.#intentsBySessionId.set(sessionId, intent);
    await this.#store?.write(sessionId, intent);
    if (options.schedule !== false) this.#schedule(sessionId, intent);
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
