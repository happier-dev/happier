import { join } from 'node:path';

import { SessionContinuationResumePromptModeV1Schema } from '@happier-dev/protocol/sessions/continuation/recoveryV1';
import type { SessionContinuationResumePromptModeV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import {
  DurableBackoffRecoveryScheduler,
  type DurableBackoffRecoveryStore,
} from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import { connectedServiceRecoveryScopeKey, type ConnectedServiceRecoveryScope } from '../runtimeRegistry/target';
import {
  ConnectedServiceRuntimeAuthFailureKindSchema,
  type ConnectedServiceRuntimeAuthFailureKind,
} from './types';

type TemporaryThrottleIntentStatus = 'waiting' | 'checking' | 'awaiting_outcome' | 'cancelled' | 'exhausted';

export type ConnectedServiceTemporaryThrottleContinuationIntent = Readonly<{
  interruptedOriginId: string;
  resumePromptMode: SessionContinuationResumePromptModeV1;
  customResumePrompt: string | null;
  recoveryKind: ConnectedServiceRuntimeAuthFailureKind;
}>;

export type ConnectedServiceTemporaryThrottleRetryIntent = Readonly<{
  v: 1;
  sessionId: string;
  /** sessionId is the durable scheduler's opaque key; scope is the runtime authority. */
  scope?: ConnectedServiceRecoveryScope;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  status: TemporaryThrottleIntentStatus;
  issueFingerprint: string;
  armedAtMs: number;
  nextRetryAtMs: number | null;
  retryAfterMs: number | null;
  resetAtMs: number | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  continuation: ConnectedServiceTemporaryThrottleContinuationIntent | null;
  capacityFailureCount?: number;
}>;

type ConnectedServiceTemporaryThrottleRetrySchedulerDeps = Readonly<{
  nowMs: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: () => number;
  random?: () => number;
  onStateChange?: (sessionId: string, intent: ConnectedServiceTemporaryThrottleRetryIntent | null, previous: ConnectedServiceTemporaryThrottleRetryIntent | null) => Promise<void> | void;
  store?: DurableBackoffRecoveryStore<ConnectedServiceTemporaryThrottleRetryIntent> | null;
  resume: (
    intent: ConnectedServiceTemporaryThrottleRetryIntent,
    context: Readonly<{ sessionId: string }>,
  ) => Promise<
    | Readonly<{ status: 'continued' }>
    | Readonly<{ status: 'superseded'; reason: string }>
    | Readonly<{ status: 'terminal'; lastError: string }>
  >;
}>;

type EnableTemporaryThrottleRetryInput = Readonly<{
  sessionId: string;
  scope?: ConnectedServiceRecoveryScope;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  issueFingerprint: string;
  retryAfterMs?: number | null;
  resetAtMs?: number | null;
  continuation?: ConnectedServiceTemporaryThrottleContinuationIntent | null;
}>;

function createDefaultTemporaryThrottleRetryStore(): DurableBackoffRecoveryStore<ConnectedServiceTemporaryThrottleRetryIntent> {
  return createRecoveryIntentFileStore(join(
    configuration.activeServerDir,
    'connected-services',
    'temporary-throttle-recovery.json',
  ));
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeContinuationIntent(
  value: unknown,
): ConnectedServiceTemporaryThrottleContinuationIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const interruptedOriginId = normalizeString(record.interruptedOriginId);
  const resumePromptMode = SessionContinuationResumePromptModeV1Schema.safeParse(record.resumePromptMode);
  const recoveryKind = ConnectedServiceRuntimeAuthFailureKindSchema.safeParse(record.recoveryKind);
  if (!interruptedOriginId || !resumePromptMode.success || !recoveryKind.success) return null;
  return {
    interruptedOriginId,
    resumePromptMode: resumePromptMode.data,
    customResumePrompt: typeof record.customResumePrompt === 'string'
      ? record.customResumePrompt
      : null,
    recoveryKind: recoveryKind.data,
  };
}

function buildOccurrenceFingerprint(
  issueFingerprint: string,
  continuation: ConnectedServiceTemporaryThrottleContinuationIntent | null,
): string {
  return continuation
    ? `${issueFingerprint}:origin:${continuation.interruptedOriginId}`
    : issueFingerprint;
}

function normalizeIntent(value: unknown): ConnectedServiceTemporaryThrottleRetryIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (
    record.status !== 'waiting'
    && record.status !== 'checking'
    && record.status !== 'awaiting_outcome'
    && record.status !== 'cancelled'
    && record.status !== 'exhausted'
  ) return null;
  const sessionId = normalizeString(record.sessionId);
  const serviceId = normalizeString(record.serviceId);
  const issueFingerprint = normalizeString(record.issueFingerprint);
  const armedAtMs = normalizeNonNegativeInteger(record.armedAtMs);
  const nextRetryAtMs = record.nextRetryAtMs === null ? null : normalizeNonNegativeInteger(record.nextRetryAtMs);
  const retryAfterMs = record.retryAfterMs === null ? null : normalizeNonNegativeInteger(record.retryAfterMs);
  const resetAtMs = record.resetAtMs === null ? null : normalizeNonNegativeInteger(record.resetAtMs);
  const attemptCount = normalizeNonNegativeInteger(record.attemptCount);
  const maxAttempts = normalizeNonNegativeInteger(record.maxAttempts);
  if (
    !sessionId
    || !serviceId
    || !issueFingerprint
    || armedAtMs === null
    || nextRetryAtMs === undefined
    || retryAfterMs === undefined
    || resetAtMs === undefined
    || attemptCount === null
    || maxAttempts === null
  ) return null;
  const continuation = normalizeContinuationIntent(record.continuation);
  const rawScope = record.scope;
  const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
    ? rawScope as Record<string, unknown> : null;
  if (scope && (scope.kind !== 'run' || !normalizeString(scope.runId) || sessionId !== connectedServiceRecoveryScopeKey({ kind: 'run', runId: normalizeString(scope.runId) }))) return null;
  return {
    v: 1,
    sessionId,
    ...(scope ? { scope: { kind: 'run' as const, runId: normalizeString(scope.runId) } } : {}),
    serviceId,
    profileId: normalizeString(record.profileId) || null,
    groupId: normalizeString(record.groupId) || null,
    status: record.status,
    issueFingerprint,
    armedAtMs,
    nextRetryAtMs,
    retryAfterMs,
    resetAtMs,
    attemptCount,
    maxAttempts: 0,
    lastError: normalizeString(record.lastError) || null,
    continuation,
    ...(normalizeNonNegativeInteger(record.capacityFailureCount) !== null
      ? { capacityFailureCount: normalizeNonNegativeInteger(record.capacityFailureCount)! }
      : {}),
  };
}

function resolveInitialRetryAtMs(input: Readonly<{
  nowMs: number;
  retryAfterMs: number | null;
  resetAtMs: number | null;
  baseBackoffMs: number;
}>): number {
  if (input.resetAtMs !== null && input.resetAtMs >= input.nowMs) return input.resetAtMs;
  if (input.retryAfterMs !== null) return input.nowMs + input.retryAfterMs;
  return input.nowMs + input.baseBackoffMs;
}

function mergeTemporaryThrottleIntent(
  previous: ConnectedServiceTemporaryThrottleRetryIntent | null,
  next: ConnectedServiceTemporaryThrottleRetryIntent,
): ConnectedServiceTemporaryThrottleRetryIntent {
  if (!previous) return next;
  if (previous.issueFingerprint !== next.issueFingerprint) return next;
  if (previous.status === 'cancelled' || previous.status === 'exhausted') return previous;
  return {
    ...next,
    status: previous.status,
    attemptCount: previous.attemptCount,
    nextRetryAtMs: previous.nextRetryAtMs === null
      ? next.nextRetryAtMs
      : Math.min(previous.nextRetryAtMs, next.nextRetryAtMs ?? previous.nextRetryAtMs),
    lastError: previous.lastError,
    maxAttempts: 0,
  };
}

export class ConnectedServiceTemporaryThrottleRetryScheduler {
  readonly #nowMs: () => number;
  readonly #baseBackoffMs: number;
  readonly #random: () => number;
  readonly #hasDurableStore: boolean;
  readonly #scheduler: DurableBackoffRecoveryScheduler<ConnectedServiceTemporaryThrottleRetryIntent>;
  readonly #runWaiters = new Map<string, (result: Readonly<{ status: 'resumed' | 'cancelled' | 'unavailable' }>) => void>();

  constructor(private readonly deps: ConnectedServiceTemporaryThrottleRetrySchedulerDeps) {
    this.#nowMs = deps.nowMs;
    this.#random = deps.random ?? Math.random;
    this.#baseBackoffMs = Math.max(1, Math.trunc(deps.baseBackoffMs ?? 1_000));
    const sourceStore = deps.store === undefined
      ? createDefaultTemporaryThrottleRetryStore()
      : deps.store;
    const settleRunWaiter = (key: string, intent: ConnectedServiceTemporaryThrottleRetryIntent | null) => {
      if (intent?.scope?.kind !== 'run') return;
      if (intent.status === 'awaiting_outcome') this.#runWaiters.get(key)?.({ status: 'resumed' });
      else if (intent.status === 'cancelled' || intent.status === 'exhausted') this.#runWaiters.get(key)?.({ status: 'cancelled' });
    };
    const store: DurableBackoffRecoveryStore<ConnectedServiceTemporaryThrottleRetryIntent> | null = sourceStore ? {
      ...sourceStore,
      write: async (sessionId: string, intent: ConnectedServiceTemporaryThrottleRetryIntent) => {
        const previous = normalizeIntent(sourceStore.readAuthoritative?.(sessionId) ?? sourceStore.read(sessionId));
        await sourceStore.write(sessionId, intent);
        await deps.onStateChange?.(sessionId, intent, previous);
        settleRunWaiter(sessionId, intent);
      },
      ...(sourceStore.remove ? { remove: async (sessionId: string) => {
        const previous = normalizeIntent(sourceStore.readAuthoritative?.(sessionId) ?? sourceStore.read(sessionId));
        await sourceStore.remove!(sessionId);
        await deps.onStateChange?.(sessionId, null, previous);
        if (previous?.scope?.kind === 'run') this.#runWaiters.get(sessionId)?.({ status: 'cancelled' });
      } } : {}),
      ...(sourceStore.transact ? { transact: async <TResult>(sessionId: string, transaction: Parameters<NonNullable<typeof sourceStore.transact>>[1]): Promise<TResult> => {
        let previous: ConnectedServiceTemporaryThrottleRetryIntent | null = null;
        let intentChanged = false;
        const result = await sourceStore.transact!(sessionId, (current) => {
          previous = current.intent;
          const next = transaction(current);
          intentChanged = next.intent !== current.intent;
          return next;
        });
        // No-op cancellation and rejected stale occurrences have no presentation
        // change. In particular, Stop must not fetch Home state for null → null.
        if (!intentChanged) return result as TResult;
        const current = normalizeIntent(sourceStore.readAuthoritative?.(sessionId) ?? sourceStore.read(sessionId));
        await deps.onStateChange?.(sessionId, current, previous);
        settleRunWaiter(sessionId, current);
        return result as TResult;
      } } : {}),
    } : sourceStore;
    this.#hasDurableStore = Boolean(store);
    this.#scheduler = new DurableBackoffRecoveryScheduler<ConnectedServiceTemporaryThrottleRetryIntent>({
      nowMs: deps.nowMs,
      baseBackoffMs: this.#baseBackoffMs,
      maxBackoffMs: deps.maxBackoffMs,
      jitterMs: deps.jitterMs,
      ...(store ? { store } : {}),
      normalizeIntent,
      getStatus: (intent) => intent.status === 'awaiting_outcome' ? 'checking' : intent.status,
      getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: () => 0,
      markChecking: (intent, attemptCount) => ({
        ...intent,
        status: 'checking',
        attemptCount,
      }),
      markWaiting: (intent, input) => ({
        ...intent,
        status: 'waiting',
        nextRetryAtMs: input.nextRetryAtMs,
        lastError: input.lastError,
      }),
      markCancelled: (intent) => ({
        ...intent,
        status: 'cancelled',
        nextRetryAtMs: null,
        lastError: null,
      }),
      markExhausted: (intent, input) => ({
        ...intent,
        status: 'exhausted',
        nextRetryAtMs: null,
        lastError: input.lastError,
      }),
      recover: async (intent, context) => {
        const runWaiter = intent.scope?.kind === 'run' ? this.#runWaiters.get(context.sessionId) : null;
        if (intent.scope?.kind === 'run' && !runWaiter) return { status: 'superseded', reason: 'run_waiter_unavailable' };
        const result = await (runWaiter
          ? Promise.resolve({ status: 'continued' as const })
          : deps.resume(intent, { sessionId: context.sessionId })).catch((error: unknown) => {
          if (intent.continuation?.recoveryKind !== 'capacity') throw error;
          return { status: 'retry' as const, lastError: error instanceof Error ? error.message : 'temporary_throttle_resume_failed' };
        });
        if (result.status === 'retry') {
          return { status: 'wait', nextRetryAtMs: this.#capacityRetryAtMs(Math.max(intent.capacityFailureCount ?? 1, intent.attemptCount + 1), intent.retryAfterMs, intent.resetAtMs), lastError: result.lastError };
        }
        if (result.status === 'superseded') {
          if (intent.continuation?.recoveryKind === 'capacity') {
            return { status: 'exhausted', lastError: result.reason, wakeResult: { status: 'superseded' } };
          }
          return {
            status: 'superseded',
            reason: result.reason,
            wakeResult: { status: 'superseded' },
          };
        }
        if (result.status === 'terminal') {
          return {
            status: 'terminal',
            lastError: result.lastError,
            intent: {
              ...intent,
              status: 'cancelled',
              nextRetryAtMs: null,
              lastError: result.lastError,
            },
            wakeResult: { status: 'terminal' },
          };
        }
        if (runWaiter || intent.continuation?.recoveryKind === 'capacity') {
          return { status: 'pending', intent: { ...intent, status: 'awaiting_outcome', nextRetryAtMs: null }, wakeResult: { status: 'resumed' } };
        }
        return { status: 'success', wakeResult: { status: 'resumed' } };
      },
      honorTimerNotBefore: true,
      exhaustAfterWait: false,
    });
  }

  async enable(input: EnableTemporaryThrottleRetryInput): Promise<Readonly<{
    status: string;
    nextRetryAtMs: number | null;
    attemptCount: number;
    maxAttempts: number;
  }>> {
    if (!this.#hasDurableStore) {
      return {
        status: 'unsupported',
        nextRetryAtMs: null,
        attemptCount: 0,
        maxAttempts: 0,
      };
    }
    const sessionId = normalizeString(input.sessionId);
    const serviceId = normalizeString(input.serviceId);
    const baseIssueFingerprint = normalizeString(input.issueFingerprint);
    const continuation = normalizeContinuationIntent(input.continuation ?? null);
    const issueFingerprint = buildOccurrenceFingerprint(baseIssueFingerprint, continuation);
    const nowMs = this.#nowMs();
    const retryAfterMs = normalizeNonNegativeInteger(input.retryAfterMs);
    const resetAtMs = normalizeNonNegativeInteger(input.resetAtMs);
    const intent: ConnectedServiceTemporaryThrottleRetryIntent = {
      v: 1,
      sessionId,
      ...(input.scope?.kind === 'run' ? { scope: input.scope } : {}),
      serviceId,
      profileId: normalizeString(input.profileId) || null,
      groupId: normalizeString(input.groupId) || null,
      status: 'waiting',
      issueFingerprint,
      armedAtMs: nowMs,
      nextRetryAtMs: resolveInitialRetryAtMs({
        nowMs,
        retryAfterMs,
        resetAtMs,
        baseBackoffMs: this.#baseBackoffMs,
      }),
      retryAfterMs,
      resetAtMs,
      attemptCount: 0,
      maxAttempts: 0,
      lastError: null,
      continuation,
    };
    const persisted = await this.#scheduler.upsertMerged({
      sessionId,
      intent,
      merge: (previous, next) => {
        if (next.continuation?.recoveryKind !== 'capacity') return mergeTemporaryThrottleIntent(previous, next);
        const sameSelection = previous?.continuation?.recoveryKind === 'capacity'
          && previous.serviceId === next.serviceId && previous.profileId === next.profileId && previous.groupId === next.groupId;
        // Older successful handoffs also wrote cancelled, without a failure streak.
        // Preserve their old per-occurrence semantics rather than inventing a Stop.
        const sameStreak = sameSelection && (previous.capacityFailureCount ?? 0) > 0;
        const duplicate = sameSelection && previous.issueFingerprint === next.issueFingerprint;
        if (duplicate && (previous.status === 'cancelled' || previous.status === 'exhausted' || previous.status === 'checking' || previous.status === 'awaiting_outcome')) return previous;
        const capacityFailureCount = sameStreak
          ? (previous.capacityFailureCount ?? 1) + (duplicate ? 0 : 1)
          : 1;
        const nextRetryAtMs = duplicate && previous.nextRetryAtMs !== null
          ? Math.max(previous.nextRetryAtMs, previous.armedAtMs + (next.retryAfterMs ?? 0), next.resetAtMs ?? 0)
          : this.#capacityRetryAtMs(capacityFailureCount, next.retryAfterMs, next.resetAtMs);
        if (duplicate && previous.nextRetryAtMs === nextRetryAtMs) return previous;
        return {
          ...next,
          ...(duplicate ? { status: previous.status, armedAtMs: previous.armedAtMs } : {}),
          capacityFailureCount,
          attemptCount: sameStreak ? previous.attemptCount : 0,
          maxAttempts: 0,
          nextRetryAtMs,
          ...(sameStreak && previous.status === 'cancelled' ? { status: 'cancelled', nextRetryAtMs: null } : {}),
        };
      },
    });
    return {
      status: persisted.status,
      nextRetryAtMs: persisted.nextRetryAtMs,
      attemptCount: persisted.attemptCount,
      maxAttempts: persisted.maxAttempts,
    };
  }

  read(sessionId: string): ConnectedServiceTemporaryThrottleRetryIntent | null {
    return this.#scheduler.read(sessionId);
  }

  async finishRun(runId: string): Promise<void> {
    const sessionId = connectedServiceRecoveryScopeKey({ kind: 'run', runId });
    this.#runWaiters.get(sessionId)?.({ status: 'cancelled' });
    await this.#scheduler.transact({ sessionId, transaction: () => ({ intent: null, result: undefined }) });
  }

  async waitForRecovery(input: Omit<EnableTemporaryThrottleRetryInput, 'sessionId' | 'scope'> & Readonly<{
    scope: Extract<ConnectedServiceRecoveryScope, { kind: 'run' }>;
  }>, signal: AbortSignal): Promise<Readonly<{ status: 'resumed' | 'cancelled' | 'unavailable' }>> {
    if (signal.aborted) return { status: 'cancelled' };
    const sessionId = connectedServiceRecoveryScopeKey(input.scope);
    if (this.#runWaiters.has(sessionId)) return { status: 'unavailable' };
    let settle!: (result: Readonly<{ status: 'resumed' | 'cancelled' | 'unavailable' }>) => void;
    const completed = new Promise<Readonly<{ status: 'resumed' | 'cancelled' | 'unavailable' }>>((resolve) => { settle = resolve; });
    this.#runWaiters.set(sessionId, settle);
    let armed: ConnectedServiceTemporaryThrottleRetryIntent | null = null;
    const cancel = () => {
      settle({ status: 'cancelled' });
      if (armed) void this.cancel({ sessionId, issueFingerprint: armed.issueFingerprint, armedAtMs: armed.armedAtMs });
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const enabled = await this.enable({ ...input, sessionId });
      armed = this.read(sessionId);
      if (signal.aborted) cancel();
      if (enabled.status === 'unsupported' || enabled.status === 'cancelled' || enabled.status === 'exhausted') settle({ status: 'unavailable' });
      return await completed;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (this.#runWaiters.get(sessionId) === settle) this.#runWaiters.delete(sessionId);
    }
  }

  hydrate(options: Readonly<{ schedule?: boolean }> = {}): ReadonlyArray<ConnectedServiceTemporaryThrottleRetryIntent> {
    return this.#scheduler.hydrate(options);
  }

  async wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'manual' }>): Promise<Readonly<{ status: string }>> {
    let intent = this.read(input.sessionId);
    if (intent?.status === 'awaiting_outcome') return { status: 'awaiting_outcome' };
    if (input.reason === 'manual' && intent?.continuation?.recoveryKind === 'capacity'
      && (intent.status === 'cancelled' || intent.status === 'exhausted')) {
      intent = await this.#scheduler.transact({ sessionId: input.sessionId, transaction: (current) => {
        if (!current || (current.status !== 'cancelled' && current.status !== 'exhausted')) return { intent: current, result: current };
        const providerNotBeforeMs = Math.max(current.retryAfterMs === null ? 0 : current.armedAtMs + current.retryAfterMs, current.resetAtMs ?? 0);
        const armedAtMs = Math.max(this.#nowMs(), current.armedAtMs + 1);
        const rearmed = {
          ...current,
          status: 'waiting' as const,
          armedAtMs,
          retryAfterMs: providerNotBeforeMs > armedAtMs ? providerNotBeforeMs - armedAtMs : null,
          nextRetryAtMs: Math.max(this.#nowMs(), providerNotBeforeMs),
        };
        return { intent: rearmed, result: rearmed };
      } });
    }
    if (intent?.status === 'waiting' && intent.continuation?.recoveryKind === 'capacity'
      && this.#nowMs() < Math.max(intent.retryAfterMs === null ? 0 : intent.armedAtMs + intent.retryAfterMs, intent.resetAtMs ?? 0)) {
      return { status: 'waiting' };
    }
    return this.#scheduler.wake(input);
  }

  async recordTurnLifecycle(input: Readonly<{
    sessionId: string;
    observedAtMs: number;
    event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';
    terminalStatus?: 'completed' | 'failed';
  }>): Promise<void> {
    if (input.event !== 'assistant_message_end' || input.terminalStatus !== 'completed') return;
    await this.#scheduler.transact({ sessionId: input.sessionId, transaction: (current) => ({
      intent: current?.continuation?.recoveryKind === 'capacity' && input.observedAtMs >= current.armedAtMs ? null : current,
      result: undefined,
    }) });
  }

  #capacityRetryAtMs(failureCount: number, retryAfterMs: number | null, resetAtMs: number | null): number {
    const delayMs = Math.min(300_000, 5_000 * (2 ** Math.min(6, Math.max(0, failureCount - 1))));
    const jitteredDelayMs = Math.round(delayMs * (0.8 + 0.4 * Math.max(0, Math.min(1, this.#random()))));
    return Math.max(this.#nowMs() + jitteredDelayMs, this.#nowMs() + (retryAfterMs ?? 0), resetAtMs ?? 0);
  }

  cancel(input: Readonly<{ sessionId: string; issueFingerprint?: string; armedAtMs?: number }>): Promise<ConnectedServiceTemporaryThrottleRetryIntent | null> {
    return this.#scheduler.cancel({
      sessionId: input.sessionId,
      matches: (intent) => (input.issueFingerprint === undefined || intent.issueFingerprint === input.issueFingerprint)
        && (input.armedAtMs === undefined || intent.armedAtMs === input.armedAtMs),
    });
  }

  dispose(): void {
    for (const waiter of this.#runWaiters.values()) waiter({ status: 'cancelled' });
    this.#runWaiters.clear();
    this.#scheduler.dispose();
  }
}
