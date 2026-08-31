import {
  DurableBackoffRecoveryScheduler,
  type DurableRecoveryStore,
} from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import {
  SessionContinuationResumePromptModeV1Schema,
  type SessionContinuationResumePromptModeV1,
} from '@happier-dev/protocol';
import {
  ConnectedServiceRuntimeAuthFailureKindSchema,
  type ConnectedServiceRuntimeAuthFailureKind,
} from '../runtimeAuth/types';

type TemporaryThrottleStatus = 'waiting' | 'checking' | 'exhausted' | 'cancelled';

export type TemporaryThrottleContinuationIntent = Readonly<{
  interruptedOriginId: string;
  resumePromptMode: SessionContinuationResumePromptModeV1;
  customResumePrompt: string | null;
  recoveryKind: ConnectedServiceRuntimeAuthFailureKind;
}>;

export type TemporaryThrottleRecoveryIntent = Readonly<{
  v: 1;
  status: TemporaryThrottleStatus;
  issueFingerprint: string;
  armedAtMs: number;
  nextRetryAtMs: number | null;
  retryAfterMs: number | null;
  resetAtMs: number | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  continuation: TemporaryThrottleContinuationIntent | null;
}>;

type TemporaryThrottleRetryResult = Readonly<{
  status: 'ready' | 'wait' | 'exhausted';
  retryAfterMs?: number | null;
  lastError?: string | null;
}>;

type TemporaryThrottleRecoverySchedulerDeps = Readonly<{
  nowMs: () => number;
  jitterMs?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  retry?: (
    intent: TemporaryThrottleRecoveryIntent,
    context: { sessionId: string },
  ) => Promise<TemporaryThrottleRetryResult>;
  resume?: (
    intent: TemporaryThrottleRecoveryIntent,
    context: { sessionId: string },
  ) => Promise<
    | Readonly<{ status: 'continued' }>
    | Readonly<{ status: 'superseded'; reason: string }>
    | Readonly<{ status: 'terminal'; lastError: string }>
  >;
  store?: DurableRecoveryStore<TemporaryThrottleRecoveryIntent>;
}>;

type EnableTemporaryThrottleRecoveryInput = Readonly<{
  sessionId: string;
  issueFingerprint: string;
  retryAfterMs?: number | null;
  resetAtMs?: number | null;
  maxAttempts?: number;
  continuation?: Readonly<{
    interruptedOriginId: string;
    resumePromptMode: SessionContinuationResumePromptModeV1;
    customResumePrompt?: string | null;
    recoveryKind: ConnectedServiceRuntimeAuthFailureKind;
  }> | null;
}>;

const defaultMaxAttempts = 3;
const defaultBaseBackoffMs = 1_000;
const defaultMaxBackoffMs = 60_000;

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function normalizeContinuationIntent(value: unknown): TemporaryThrottleContinuationIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const interruptedOriginId = typeof record.interruptedOriginId === 'string'
    ? record.interruptedOriginId.trim()
    : '';
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
  continuation: TemporaryThrottleContinuationIntent | null,
): string {
  return continuation
    ? `${issueFingerprint}:origin:${continuation.interruptedOriginId}`
    : issueFingerprint;
}

function normalizeIntent(value: unknown): TemporaryThrottleRecoveryIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (
    record.status !== 'waiting'
    && record.status !== 'checking'
    && record.status !== 'exhausted'
    && record.status !== 'cancelled'
  ) {
    return null;
  }
  const issueFingerprint = typeof record.issueFingerprint === 'string' ? record.issueFingerprint.trim() : '';
  const armedAtMs = normalizeNonNegativeInteger(record.armedAtMs);
  const nextRetryAtMs = record.nextRetryAtMs === null ? null : normalizeNonNegativeInteger(record.nextRetryAtMs);
  const retryAfterMs = record.retryAfterMs === null ? null : normalizeNonNegativeInteger(record.retryAfterMs);
  const resetAtMs = record.resetAtMs === null ? null : normalizeNonNegativeInteger(record.resetAtMs);
  const attemptCount = normalizeNonNegativeInteger(record.attemptCount);
  const maxAttempts = normalizeNonNegativeInteger(record.maxAttempts);
  const lastError = record.lastError === null
    ? null
    : typeof record.lastError === 'string' && record.lastError.trim().length > 0
    ? record.lastError.trim()
    : null;
  if (
    issueFingerprint.length === 0
    || armedAtMs === null
    || nextRetryAtMs === undefined
    || retryAfterMs === undefined
    || resetAtMs === undefined
    || attemptCount === null
    || maxAttempts === null
  ) {
    return null;
  }
  return {
    v: 1,
    status: record.status,
    issueFingerprint,
    armedAtMs,
    nextRetryAtMs,
    retryAfterMs,
    resetAtMs,
    attemptCount,
    maxAttempts,
    lastError,
    continuation: normalizeContinuationIntent(record.continuation),
  };
}

export class TemporaryThrottleRecoveryScheduler {
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly scheduler: DurableBackoffRecoveryScheduler<TemporaryThrottleRecoveryIntent>;

  constructor(private readonly deps: TemporaryThrottleRecoverySchedulerDeps) {
    this.baseBackoffMs = Math.max(1, Math.trunc(deps.baseBackoffMs ?? defaultBaseBackoffMs));
    this.maxBackoffMs = Math.max(this.baseBackoffMs, Math.trunc(deps.maxBackoffMs ?? defaultMaxBackoffMs));
    this.scheduler = new DurableBackoffRecoveryScheduler<TemporaryThrottleRecoveryIntent>({
      nowMs: deps.nowMs,
      baseBackoffMs: this.baseBackoffMs,
      maxBackoffMs: this.maxBackoffMs,
      jitterMs: deps.jitterMs,
      store: deps.store,
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
      recover: async (intent, { sessionId }) => await this.recoverIntent(intent, { sessionId }),
    });
  }

  async enable(input: EnableTemporaryThrottleRecoveryInput): Promise<{
    status: TemporaryThrottleStatus;
    nextRetryAtMs: number | null;
    attemptCount: number;
  }> {
    const retryAfterMs = normalizeNonNegativeInteger(input.retryAfterMs);
    const resetAtMs = normalizeNonNegativeInteger(input.resetAtMs);
    const nowMs = this.deps.nowMs();
    const continuation = normalizeContinuationIntent(input.continuation ?? null);
    const nextIntent: TemporaryThrottleRecoveryIntent = {
      v: 1,
      status: 'waiting',
      issueFingerprint: buildOccurrenceFingerprint(input.issueFingerprint, continuation),
      armedAtMs: nowMs,
      retryAfterMs,
      resetAtMs,
      nextRetryAtMs: this.resolveInitialRetryAtMs({
        nowMs,
        retryAfterMs,
        resetAtMs,
      }),
      attemptCount: 0,
      maxAttempts: Math.max(1, Math.trunc(input.maxAttempts ?? defaultMaxAttempts)),
      lastError: null,
      continuation,
    };
    const intent = await this.scheduler.upsertMerged({
      sessionId: input.sessionId,
      intent: nextIntent,
      merge: (previous, next) => this.mergeSameTemporaryThrottleIntent(previous, next),
    });
    return {
      status: intent.status,
      nextRetryAtMs: intent.nextRetryAtMs,
      attemptCount: intent.attemptCount,
    };
  }

  private mergeSameTemporaryThrottleIntent(
    previous: TemporaryThrottleRecoveryIntent | null,
    next: TemporaryThrottleRecoveryIntent,
  ): TemporaryThrottleRecoveryIntent {
    if (!previous || previous.issueFingerprint !== next.issueFingerprint) return next;
    if (previous.status === 'exhausted') return previous;
    if (previous.status === 'cancelled') return previous;
    if (previous.status === 'checking') return previous;
    if (previous.status !== 'waiting') return next;
    const previousRetrySooner = previous.nextRetryAtMs !== null
      && (next.nextRetryAtMs === null || previous.nextRetryAtMs <= next.nextRetryAtMs);
    return {
      ...next,
      armedAtMs: previous.armedAtMs,
      attemptCount: previous.attemptCount,
      maxAttempts: Math.max(1, Math.min(previous.maxAttempts, next.maxAttempts)),
      retryAfterMs: previousRetrySooner ? previous.retryAfterMs : next.retryAfterMs,
      resetAtMs: previousRetrySooner ? previous.resetAtMs : next.resetAtMs,
      nextRetryAtMs: previousRetrySooner ? previous.nextRetryAtMs : next.nextRetryAtMs,
      lastError: previous.lastError,
    };
  }

  read(sessionId: string): TemporaryThrottleRecoveryIntent | null {
    return this.scheduler.readByKeyPassive(sessionId);
  }

  hydrate(): ReadonlyArray<TemporaryThrottleRecoveryIntent> {
    return this.scheduler.hydratePassive();
  }

  dispose(): void {
    this.scheduler.dispose();
  }

  async wake(input: { sessionId: string; reason: 'timer' | 'retry_now' }): Promise<{ status: string }> {
    const result = await this.scheduler.wake({
      sessionId: input.sessionId,
      reason: input.reason,
    });
    return result.status === 'succeeded' ? { status: 'resumed' } : result;
  }

  private async recoverIntent(
    intent: TemporaryThrottleRecoveryIntent,
    context: { sessionId: string },
  ): Promise<
    | Readonly<{ status: 'success'; intent: TemporaryThrottleRecoveryIntent }>
    | Readonly<{ status: 'wait'; nextRetryAtMs: number; lastError: string | null; intent: TemporaryThrottleRecoveryIntent }>
    | Readonly<{ status: 'exhausted'; lastError: string | null }>
    | Readonly<{ status: 'terminal'; lastError: string; intent: TemporaryThrottleRecoveryIntent }>
    | Readonly<{ status: 'superseded'; reason: string }>
  > {
    const nowMs = this.deps.nowMs();
    let result: TemporaryThrottleRetryResult;
    try {
      result = await (this.deps.retry?.(intent, { sessionId: context.sessionId })
        ?? Promise.resolve({ status: 'ready' as const }));
    } catch {
      return {
        status: 'wait',
        nextRetryAtMs: nowMs + this.computeBackoffMs(intent.attemptCount),
        lastError: 'temporary_throttle_probe_failed',
        intent: {
          ...intent,
          retryAfterMs: null,
        },
      };
    }
    if (result.status === 'ready') {
      let resumeResult:
        | Readonly<{ status: 'continued' }>
        | Readonly<{ status: 'superseded'; reason: string }>
        | Readonly<{ status: 'terminal'; lastError: string }>;
      try {
        resumeResult = await (this.deps.resume?.(intent, { sessionId: context.sessionId })
          ?? Promise.resolve({
            status: 'terminal' as const,
            lastError: 'temporary_throttle_continuation_unavailable',
          }));
      } catch {
        return {
          status: 'wait',
          nextRetryAtMs: nowMs + this.computeBackoffMs(intent.attemptCount),
          lastError: 'temporary_throttle_resume_failed',
          intent: {
            ...intent,
            retryAfterMs: null,
          },
        };
      }
      if (resumeResult.status === 'superseded') {
        return { status: 'superseded', reason: resumeResult.reason };
      }
      if (resumeResult.status === 'terminal') {
        return {
          status: 'terminal',
          lastError: resumeResult.lastError,
          intent: {
            ...intent,
            status: 'cancelled',
            nextRetryAtMs: null,
            lastError: resumeResult.lastError,
          },
        };
      }
      return {
        status: 'success',
        intent: {
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        },
      };
    }
    if (result.status === 'exhausted') {
      return {
        status: 'exhausted',
        lastError: result.lastError ?? 'max_attempts_exhausted',
      };
    }

    const retryAfterMs = normalizeNonNegativeInteger(result.retryAfterMs);
    return {
      status: 'wait',
      nextRetryAtMs: nowMs + (retryAfterMs ?? this.computeBackoffMs(intent.attemptCount)),
      lastError: typeof result.lastError === 'string' && result.lastError.trim().length > 0
        ? result.lastError.trim()
        : null,
      intent: {
        ...intent,
        retryAfterMs,
      },
    };
  }

  retryNow(input: { sessionId: string }): Promise<{ status: string }> {
    return this.wake({ sessionId: input.sessionId, reason: 'retry_now' });
  }

  async stopRetrying(input: { sessionId: string }): Promise<{ status: string } | null> {
    const intent = await this.scheduler.cancel({ sessionId: input.sessionId });
    return intent ? { status: 'cancelled' } : null;
  }

  private computeBackoffMs(attemptCount: number): number {
    const exponential = this.baseBackoffMs * (2 ** attemptCount);
    return Math.min(this.maxBackoffMs, exponential) + Math.max(0, Math.trunc(this.deps.jitterMs?.() ?? 0));
  }

  private resolveInitialRetryAtMs(input: Readonly<{
    nowMs: number;
    retryAfterMs: number | null;
    resetAtMs: number | null;
  }>): number {
    if (input.resetAtMs !== null && input.resetAtMs >= input.nowMs) return input.resetAtMs;
    return input.nowMs + (input.retryAfterMs ?? this.computeBackoffMs(0));
  }
}
