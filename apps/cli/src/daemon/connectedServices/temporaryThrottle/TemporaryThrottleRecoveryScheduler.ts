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
import { computeCapacityBackoffMs } from './capacityBackoff';

type TemporaryThrottleStatus = 'waiting' | 'checking' | 'awaiting_outcome' | 'exhausted' | 'cancelled';

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
  capacityFailureCount?: number;
  maxAttempts: number;
  lastError: string | null;
  continuation: TemporaryThrottleContinuationIntent | null;
  serviceId?: string;
  profileId?: string | null;
  groupId?: string | null;
}>;

type TemporaryThrottleRetryResult = Readonly<{
  status: 'ready' | 'wait' | 'exhausted';
  retryAfterMs?: number | null;
  lastError?: string | null;
}>;

type TemporaryThrottleRecoverySchedulerDeps = Readonly<{
  nowMs: () => number;
  jitterMs?: () => number;
  random?: () => number;
  onStateChange?: (sessionId: string, intent: TemporaryThrottleRecoveryIntent | null, previous: TemporaryThrottleRecoveryIntent | null) => Promise<void> | void;
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
  serviceId?: string;
  profileId?: string | null;
  groupId?: string | null;
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
    && record.status !== 'awaiting_outcome'
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
  const continuation = normalizeContinuationIntent(record.continuation);
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
    capacityFailureCount: normalizeNonNegativeInteger(record.capacityFailureCount) ?? 0,
    maxAttempts: continuation?.recoveryKind === 'capacity' ? 0 : maxAttempts,
    lastError,
    continuation,
    ...(typeof record.serviceId === 'string' ? { serviceId: record.serviceId } : {}),
    ...(typeof record.profileId === 'string' || record.profileId === null ? { profileId: record.profileId } : {}),
    ...(typeof record.groupId === 'string' || record.groupId === null ? { groupId: record.groupId } : {}),
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
      store: this.observeStore(deps.store),
      normalizeIntent,
      getStatus: (intent) => intent.status === 'awaiting_outcome' ? 'cancelled' : intent.status,
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

  private observeStore(store: DurableRecoveryStore<TemporaryThrottleRecoveryIntent> | undefined): DurableRecoveryStore<TemporaryThrottleRecoveryIntent> | undefined {
    if (!this.deps.onStateChange) return store;
    const memory = new Map<string, TemporaryThrottleRecoveryIntent>();
    const source: DurableRecoveryStore<TemporaryThrottleRecoveryIntent> = store ?? {
      read: (key: string) => memory.get(key) ?? null,
      readAll: () => [...memory.entries()],
      write: (key: string, intent: TemporaryThrottleRecoveryIntent) => { memory.set(key, intent); },
      remove: (key: string) => { memory.delete(key); },
    };
    const publish = async (key: string, previous: TemporaryThrottleRecoveryIntent | null) => {
      const intent = normalizeIntent(source.read(key));
      await this.deps.onStateChange?.(key, intent, previous);
    };
    return {
      ...source,
      write: async (key, intent) => {
        const previous = normalizeIntent(source.read(key));
        await source.write(key, intent);
        await publish(key, previous);
      },
      ...(source.remove ? { remove: async (key: string) => {
        const previous = normalizeIntent(source.read(key));
        await source.remove!(key);
        await publish(key, previous);
      } } : {}),
      ...(source.merge ? { merge: async (key, next, merge) => {
        const previous = normalizeIntent(source.read(key));
        const result = await source.merge!(key, next, merge);
        await publish(key, previous);
        return result;
      } } satisfies Pick<DurableRecoveryStore<TemporaryThrottleRecoveryIntent>, 'merge'> : {}),
      ...(source.transact ? { transact: async (key, transaction) => {
        const previous = normalizeIntent(source.read(key));
        const result = await source.transact!(key, transaction);
        await publish(key, previous);
        return result;
      } } satisfies Pick<DurableRecoveryStore<TemporaryThrottleRecoveryIntent>, 'transact'> : {}),
    };
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
      maxAttempts: continuation?.recoveryKind === 'capacity' ? 0 : Math.max(1, Math.trunc(input.maxAttempts ?? defaultMaxAttempts)),
      lastError: null,
      continuation,
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
    };
    const intent = await this.scheduler.upsertMerged({
      sessionId: input.sessionId,
      intent: nextIntent,
      merge: (previous, next) => this.mergeSameTemporaryThrottleIntent(previous, next, input.issueFingerprint),
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
    baseIssueFingerprint: string,
  ): TemporaryThrottleRecoveryIntent {
    if (!previous || previous.issueFingerprint !== next.issueFingerprint) {
      const capacityFailureCount = (previous?.capacityFailureCount ?? 0) + (next.continuation?.recoveryKind === 'capacity' ? 1 : 0);
      if (next.continuation?.recoveryKind !== 'capacity') return { ...next, capacityFailureCount };
      if (previous?.status === 'cancelled' && previous.continuation?.recoveryKind === 'capacity'
        && (previous.capacityFailureCount ?? 0) > 0
        && previous.issueFingerprint === buildOccurrenceFingerprint(baseIssueFingerprint, previous.continuation)) {
        return { ...next, status: 'cancelled', nextRetryAtMs: null, capacityFailureCount, attemptCount: previous.attemptCount };
      }
      return {
        ...next,
        capacityFailureCount,
        attemptCount: previous?.attemptCount ?? 0,
        nextRetryAtMs: Math.max(
          next.armedAtMs + computeCapacityBackoffMs(capacityFailureCount, this.deps.random),
          next.armedAtMs + (next.retryAfterMs ?? 0),
          next.resetAtMs ?? 0,
        ),
      };
    }
    if (previous.continuation?.recoveryKind === 'capacity') {
      if (previous.status !== 'waiting') return previous;
      const providerFloor = Math.max(
        previous.armedAtMs + (previous.retryAfterMs ?? 0), previous.resetAtMs ?? 0,
        next.retryAfterMs === null ? 0 : previous.armedAtMs + next.retryAfterMs, next.resetAtMs ?? 0,
      );
      return { ...previous,
        retryAfterMs: Math.max(0, providerFloor - previous.armedAtMs),
        nextRetryAtMs: Math.max(previous.nextRetryAtMs ?? 0, providerFloor),
      };
    }
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

  async recordTurnLifecycle(input: Readonly<{ sessionId: string; event: string; terminalStatus?: 'completed' | 'failed'; observedAtMs?: number }>): Promise<void> {
    if (input.event !== 'assistant_message_end' || input.terminalStatus !== 'completed') return;
    const current = this.read(input.sessionId);
    if (!current || !current.capacityFailureCount) return;
    if ((input.observedAtMs ?? this.deps.nowMs()) < current.armedAtMs) return;
    await this.scheduler.clearByKey(input.sessionId);
  }

  hydrate(): ReadonlyArray<TemporaryThrottleRecoveryIntent> {
    return this.scheduler.hydratePassive();
  }

  dispose(): void {
    this.scheduler.dispose();
  }

  async wake(input: { sessionId: string; reason: 'timer' | 'retry_now' }): Promise<{ status: string }> {
    let intent = this.read(input.sessionId);
    if (input.reason === 'retry_now' && intent?.continuation?.recoveryKind === 'capacity'
      && (intent.status === 'cancelled' || intent.status === 'exhausted')) {
      const nowMs = this.deps.nowMs();
      const providerFloor = Math.max(intent.retryAfterMs === null ? 0 : intent.armedAtMs + intent.retryAfterMs, intent.resetAtMs ?? 0);
      const armedAtMs = Math.max(nowMs, intent.armedAtMs + 1);
      intent = await this.scheduler.upsert({ sessionId: input.sessionId,
        intent: { ...intent, status: 'waiting', armedAtMs,
          retryAfterMs: providerFloor > armedAtMs ? providerFloor - armedAtMs : null,
          nextRetryAtMs: Math.max(nowMs, providerFloor) },
      });
    }
    if (intent?.continuation?.recoveryKind === 'capacity' && intent.status === 'waiting') {
      const providerFloor = Math.max(intent.retryAfterMs === null ? 0 : intent.armedAtMs + intent.retryAfterMs, intent.resetAtMs ?? 0);
      if (this.deps.nowMs() < providerFloor) return { status: 'waiting' };
    }
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
        nextRetryAtMs: nowMs + this.computeRetryBackoffMs(intent),
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
          nextRetryAtMs: nowMs + this.computeRetryBackoffMs(intent),
          lastError: 'temporary_throttle_resume_failed',
          intent: {
            ...intent,
            retryAfterMs: null,
          },
        };
      }
      if (resumeResult.status === 'superseded') {
        if (intent.capacityFailureCount) {
          return { status: 'terminal', lastError: resumeResult.reason,
            intent: { ...intent, status: 'exhausted', nextRetryAtMs: null, lastError: null } };
        }
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
          status: intent.continuation?.recoveryKind === 'capacity' ? 'awaiting_outcome' : 'cancelled',
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
      nextRetryAtMs: intent.continuation?.recoveryKind === 'capacity'
        ? Math.max(nowMs + this.computeRetryBackoffMs(intent), nowMs + (retryAfterMs ?? 0), intent.resetAtMs ?? 0)
        : nowMs + (retryAfterMs ?? this.computeBackoffMs(intent.attemptCount)),
      lastError: typeof result.lastError === 'string' && result.lastError.trim().length > 0
        ? result.lastError.trim()
        : null,
      intent: {
        ...intent,
        retryAfterMs: intent.continuation?.recoveryKind === 'capacity' && retryAfterMs !== null
          ? nowMs - intent.armedAtMs + retryAfterMs
          : retryAfterMs,
      },
    };
  }

  retryNow(input: { sessionId: string }): Promise<{ status: string }> {
    return this.wake({ sessionId: input.sessionId, reason: 'retry_now' });
  }

  async stopRetrying(input: { sessionId: string; issueFingerprint?: string; armedAtMs?: number }): Promise<{ status: string } | null> {
    const intent = await this.scheduler.cancel({ sessionId: input.sessionId,
      ...(input.issueFingerprint !== undefined || input.armedAtMs !== undefined ? {
        expectedCurrent: (current: TemporaryThrottleRecoveryIntent) => current.issueFingerprint === input.issueFingerprint && current.armedAtMs === input.armedAtMs,
      } : {}),
    });
    return intent ? { status: 'cancelled' } : null;
  }

  private computeBackoffMs(attemptCount: number): number {
    const exponential = this.baseBackoffMs * (2 ** attemptCount);
    return Math.min(this.maxBackoffMs, exponential) + Math.max(0, Math.trunc(this.deps.jitterMs?.() ?? 0));
  }

  private computeRetryBackoffMs(intent: TemporaryThrottleRecoveryIntent): number {
    return intent.continuation?.recoveryKind === 'capacity'
      ? computeCapacityBackoffMs(Math.max(intent.capacityFailureCount ?? 1, intent.attemptCount + 1), this.deps.random)
      : this.computeBackoffMs(intent.attemptCount);
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
