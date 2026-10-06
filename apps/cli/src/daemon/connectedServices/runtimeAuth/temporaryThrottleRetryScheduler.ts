import { join } from 'node:path';

import { SessionContinuationResumePromptModeV1Schema } from '@happier-dev/protocol/sessions/continuation/recoveryV1';
import type { SessionContinuationResumePromptModeV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import {
  DurableBackoffRecoveryScheduler,
  type DurableBackoffRecoveryStore,
} from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
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
  maxAttempts?: number;
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
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  issueFingerprint: string;
  retryAfterMs?: number | null;
  resetAtMs?: number | null;
  continuation?: ConnectedServiceTemporaryThrottleContinuationIntent | null;
}>;

const defaultMaxAttempts = 3;

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
  return {
    v: 1,
    sessionId,
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
    maxAttempts: continuation?.recoveryKind === 'capacity' ? 0 : maxAttempts,
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
    maxAttempts: Math.min(previous.maxAttempts, next.maxAttempts),
  };
}

export class ConnectedServiceTemporaryThrottleRetryScheduler {
  readonly #nowMs: () => number;
  readonly #baseBackoffMs: number;
  readonly #maxAttempts: number;
  readonly #random: () => number;
  readonly #hasDurableStore: boolean;
  readonly #scheduler: DurableBackoffRecoveryScheduler<ConnectedServiceTemporaryThrottleRetryIntent>;

  constructor(private readonly deps: ConnectedServiceTemporaryThrottleRetrySchedulerDeps) {
    this.#nowMs = deps.nowMs;
    this.#random = deps.random ?? Math.random;
    this.#baseBackoffMs = Math.max(1, Math.trunc(deps.baseBackoffMs ?? 1_000));
    this.#maxAttempts = Math.max(1, Math.trunc(deps.maxAttempts ?? defaultMaxAttempts));
    const sourceStore = deps.store === undefined
      ? createDefaultTemporaryThrottleRetryStore()
      : deps.store;
    const store: DurableBackoffRecoveryStore<ConnectedServiceTemporaryThrottleRetryIntent> | null = sourceStore && deps.onStateChange ? {
      ...sourceStore,
      write: async (sessionId: string, intent: ConnectedServiceTemporaryThrottleRetryIntent) => {
        const previous = normalizeIntent(sourceStore.readAuthoritative?.(sessionId) ?? sourceStore.read(sessionId));
        await sourceStore.write(sessionId, intent);
        await deps.onStateChange?.(sessionId, intent, previous);
      },
      ...(sourceStore.remove ? { remove: async (sessionId: string) => {
        const previous = normalizeIntent(sourceStore.readAuthoritative?.(sessionId) ?? sourceStore.read(sessionId));
        await sourceStore.remove!(sessionId);
        await deps.onStateChange?.(sessionId, null, previous);
      } } : {}),
      ...(sourceStore.transact ? { transact: async <TResult>(sessionId: string, transaction: Parameters<NonNullable<typeof sourceStore.transact>>[1]): Promise<TResult> => {
        let previous: ConnectedServiceTemporaryThrottleRetryIntent | null = null;
        const result = await sourceStore.transact!(sessionId, (current) => {
          previous = current.intent;
          return transaction(current);
        });
        await deps.onStateChange?.(sessionId, normalizeIntent(sourceStore.readAuthoritative?.(sessionId) ?? sourceStore.read(sessionId)), previous);
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
      getMaxAttempts: (intent) => intent.maxAttempts,
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
        const result = await deps.resume(intent, { sessionId: context.sessionId }).catch((error: unknown) => {
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
        if (intent.continuation?.recoveryKind === 'capacity') {
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
      maxAttempts: this.#maxAttempts,
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
    this.#scheduler.dispose();
  }
}
