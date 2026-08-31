import { join } from 'node:path';

import {
  SessionContinuationResumePromptModeV1Schema,
  type SessionContinuationResumePromptModeV1,
} from '@happier-dev/protocol';
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

type TemporaryThrottleIntentStatus = 'waiting' | 'checking' | 'cancelled' | 'exhausted';

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
}>;

type ConnectedServiceTemporaryThrottleRetrySchedulerDeps = Readonly<{
  nowMs: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: () => number;
  maxAttempts?: number;
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
    maxAttempts,
    lastError: normalizeString(record.lastError) || null,
    continuation: normalizeContinuationIntent(record.continuation),
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
  readonly #hasDurableStore: boolean;
  readonly #scheduler: DurableBackoffRecoveryScheduler<ConnectedServiceTemporaryThrottleRetryIntent>;

  constructor(private readonly deps: ConnectedServiceTemporaryThrottleRetrySchedulerDeps) {
    this.#nowMs = deps.nowMs;
    this.#baseBackoffMs = Math.max(1, Math.trunc(deps.baseBackoffMs ?? 1_000));
    this.#maxAttempts = Math.max(1, Math.trunc(deps.maxAttempts ?? defaultMaxAttempts));
    const store = deps.store === undefined
      ? createDefaultTemporaryThrottleRetryStore()
      : deps.store;
    this.#hasDurableStore = Boolean(store);
    this.#scheduler = new DurableBackoffRecoveryScheduler<ConnectedServiceTemporaryThrottleRetryIntent>({
      nowMs: deps.nowMs,
      baseBackoffMs: this.#baseBackoffMs,
      maxBackoffMs: deps.maxBackoffMs,
      jitterMs: deps.jitterMs,
      ...(store ? { store } : {}),
      normalizeIntent,
      getStatus: (intent) => intent.status,
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
        const result = await deps.resume(intent, { sessionId: context.sessionId });
        if (result.status === 'superseded') {
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
      merge: mergeTemporaryThrottleIntent,
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

  wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'manual' }>): Promise<Readonly<{ status: string }>> {
    return this.#scheduler.wake(input);
  }

  cancel(input: Readonly<{ sessionId: string }>): Promise<ConnectedServiceTemporaryThrottleRetryIntent | null> {
    return this.#scheduler.cancel(input);
  }

  dispose(): void {
    this.#scheduler.dispose();
  }
}
