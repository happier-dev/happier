import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryAuthSelectionV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import {
  UsageLimitCheckNowRateLimiter,
  USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
} from '@/session/usageLimitRecoveryControls/usageLimitCheckNowRateLimiter';
import {
  recordConnectedServiceDaemonRestartDiagnostic,
  type ConnectedServiceDaemonRestartDiagnosticRecorder,
} from '../sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { DurableBackoffRecoveryScheduler } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import type { DurableRecoveryGateResult } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';

export const RUNTIME_USAGE_LIMIT_RECOVERY_FIELD = SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID;
export const METADATA_SESSION_USAGE_LIMIT_RECOVERY_V1_KEY = SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY;

export type UsageLimitRecoveryIntent = SessionUsageLimitRecoveryV1;

type RecoveryResult =
  | Readonly<{ status: 'ready'; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1 }>
  | Readonly<{ status: 'wait'; nextCheckAtMs: number; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1; lastProbeError?: string | null }>
  | Readonly<{ status: 'exhausted'; lastProbeError?: string | null }>
  /**
   * The probe proved the intent is stale (e.g. the interrupted turn later
   * completed normally): cancel terminally without resuming.
   */
  | Readonly<{ status: 'superseded'; lastProbeError?: string | null }>
  | Readonly<{
    status: 'failed';
    resultStatus: string;
    errorCode?: string | null;
    lastProbeError?: string | null;
    details?: Readonly<Record<string, unknown>>;
  }>;

export type UsageLimitRecoveryIntentStore = Readonly<{
  read(sessionId: string): UsageLimitRecoveryIntent | unknown | null;
  readAll?: () => ReadonlyArray<readonly [sessionId: string, value: unknown]>;
  write(sessionId: string, intent: UsageLimitRecoveryIntent): Promise<void> | void;
  remove?: (sessionId: string) => Promise<void> | void;
  prune?: (predicate: (entry: Readonly<{ sessionId: string; value: unknown }>) => boolean) => Promise<ReadonlyArray<string>> | ReadonlyArray<string>;
}>;

function isUsageLimitRecoveryIntent(value: unknown): value is UsageLimitRecoveryIntent {
  return SessionUsageLimitRecoveryV1Schema.safeParse(value).success;
}

function readUsageLimitRecoveryServiceId(
  selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1,
): string | null {
  return selectedAuth.kind === 'native' ? null : selectedAuth.serviceId;
}

function readUsageLimitRecoveryProfileId(
  selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1,
): string | null {
  return selectedAuth.kind === 'native' ? null : selectedAuth.profileId;
}

function readUsageLimitRecoveryGroupId(
  selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1,
): string | null {
  return selectedAuth.kind === 'group' ? selectedAuth.groupId : null;
}

const DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS = 3;
const DEFAULT_USAGE_LIMIT_RECOVERY_TERMINAL_RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;

function resolveUsageLimitRecoveryPruneReferenceMs(intent: UsageLimitRecoveryIntent): number {
  return Math.max(
    intent.armedAtMs,
    intent.resetAtMs ?? 0,
    intent.nextCheckAtMs ?? 0,
  );
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 {
  return value === 'off' || value === 'custom' ? value : 'standard';
}

/**
 * Same-fingerprint re-arm merge for `enable()`. Mirrors `mergeTemporaryThrottleIntent`:
 * a usage-limit that resurfaces for the SAME issue must NOT reset attemptCount to 0,
 * must NOT resurrect a cancelled/exhausted terminal state, and must keep the existing
 * waiting/checking lifecycle. It DOES adopt the latest selectedAuth/resumePromptMode and
 * takes the earlier of the two next-check times. A genuinely different fingerprint (or no
 * prior intent) starts fresh.
 */
function mergeUsageLimitRecoveryRearm(
  previous: UsageLimitRecoveryIntent | null,
  next: UsageLimitRecoveryIntent,
): UsageLimitRecoveryIntent {
  if (!previous) return next;
  if (previous.issueFingerprint !== next.issueFingerprint) return next;
  if (previous.status === 'cancelled' || previous.status === 'exhausted') return previous;
  const mergedNextCheckAtMs = previous.nextCheckAtMs === null || previous.nextCheckAtMs === undefined
    ? next.nextCheckAtMs
    : next.nextCheckAtMs === null || next.nextCheckAtMs === undefined
      ? previous.nextCheckAtMs
      : Math.min(previous.nextCheckAtMs, next.nextCheckAtMs);
  return {
    ...next,
    status: previous.status,
    attemptCount: previous.attemptCount,
    nextCheckAtMs: mergedNextCheckAtMs,
    lastProbeError: previous.lastProbeError,
    maxAttempts: Math.min(previous.maxAttempts, next.maxAttempts),
  };
}

export class UsageLimitRecoveryScheduler {
  private readonly checkNowRateLimiter: UsageLimitCheckNowRateLimiter;
  private readonly scheduler: DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>;

  constructor(private readonly deps: Readonly<{
    nowMs: () => number;
    store?: UsageLimitRecoveryIntentStore;
    recover?: (intent: UsageLimitRecoveryIntent, context: Readonly<{ sessionId: string }>) => Promise<RecoveryResult>;
    resume?: (intent: UsageLimitRecoveryIntent) => Promise<void>;
    recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
    checkNowThrottleMs?: number;
    gate?: (input: Readonly<{ sessionId: string; intent: UsageLimitRecoveryIntent }>) => DurableRecoveryGateResult;
    /**
     * O4: optional resolver so callers with a known agent id (e.g. codex app-server) can
     * surface it in the restart diagnostic instead of leaving agentId null at the quota seam.
     */
    resolveAgentId?: (sessionId: string) => string | null;
  }>) {
    this.checkNowRateLimiter = new UsageLimitCheckNowRateLimiter({
      nowMs: deps.nowMs,
      throttleMs: deps.checkNowThrottleMs,
    });
    this.scheduler = new DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>({
      nowMs: deps.nowMs,
      store: deps.store,
      normalizeIntent: (value) => isUsageLimitRecoveryIntent(value) ? value : null,
      getStatus: (intent) => (
        intent.status === 'waiting'
        || intent.status === 'checking'
        || intent.status === 'cancelled'
        || intent.status === 'exhausted'
          ? intent.status
          : 'cancelled'
      ),
      getNextRetryAtMs: (intent) => intent.nextCheckAtMs ?? intent.resetAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      terminalRecordRetentionMs: DEFAULT_USAGE_LIMIT_RECOVERY_TERMINAL_RECORD_RETENTION_MS,
      getTerminalPruneReferenceMs: resolveUsageLimitRecoveryPruneReferenceMs,
      markChecking: (intent, attemptCount) => ({
        ...intent,
        status: 'checking',
        attemptCount,
      }),
      markWaiting: (intent, next) => ({
        ...intent,
        status: 'waiting',
        nextCheckAtMs: next.nextRetryAtMs,
        lastProbeError: next.lastError,
      }),
      markCancelled: (intent) => ({
        ...intent,
        status: 'cancelled',
      }),
      markExhausted: (intent, next) => ({
        ...intent,
        status: 'exhausted',
        lastProbeError: next.lastError,
      }),
      recover: async (intent, context) => await this.recoverUsageLimitIntent(intent, context),
      gate: deps.gate,
      exhaustAfterWait: false,
      honorTimerNotBefore: true,
    });
  }

  read(sessionId: string): UsageLimitRecoveryIntent | null {
    return this.scheduler.read(sessionId);
  }

  hydrate(): ReadonlyArray<UsageLimitRecoveryIntent> {
    return this.scheduler.hydrate();
  }

  upsert(input: Readonly<{
    sessionId: string;
    intent: UsageLimitRecoveryIntent;
  }>): UsageLimitRecoveryIntent {
    return this.scheduler.load(input);
  }

  async enable(input: Readonly<{
    sessionId: string;
    issueFingerprint: string;
    resetAtMs: number | null;
    nextCheckAtMs?: number | null;
    maxAttempts?: number;
    selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1;
    resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  }>): Promise<UsageLimitRecoveryIntent> {
    const nowMs = this.deps.nowMs();
    const maxAttempts = typeof input.maxAttempts === 'number' && Number.isFinite(input.maxAttempts)
      ? Math.max(0, Math.trunc(input.maxAttempts))
      : DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS;
    const intent: UsageLimitRecoveryIntent = {
      v: 1,
      issueFingerprint: input.issueFingerprint,
      status: 'waiting',
      resumePromptMode: readResumePromptMode(input.resumePromptMode),
      armedAtMs: nowMs,
      resetAtMs: input.resetAtMs,
      nextCheckAtMs: input.nextCheckAtMs ?? input.resetAtMs,
      attemptCount: 0,
      maxAttempts,
      lastProbeError: null,
      selectedAuth: input.selectedAuth,
    };
    // Merge instead of overwrite so a same-fingerprint resurfacing preserves attemptCount /
    // terminal (cancelled/exhausted) / next-check state rather than resetting the lifecycle to 0
    // and re-looping. Different fingerprint / no prior intent starts fresh.
    return await this.scheduler.upsertMerged({
      sessionId: input.sessionId,
      intent,
      merge: mergeUsageLimitRecoveryRearm,
    });
  }

  async cancel(input: Readonly<{ sessionId: string }>): Promise<UsageLimitRecoveryIntent | null> {
    return await this.scheduler.cancel(input);
  }

  async checkNow(input: Readonly<{ sessionId: string }>): Promise<Readonly<{
    status: string;
    errorCode?: string;
    retryAfterMs?: number;
  }>> {
    const rateLimit = this.checkNowRateLimiter.check(input.sessionId);
    if (!rateLimit.allowed) {
      return {
        status: 'rate_limited',
        errorCode: USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
        retryAfterMs: rateLimit.retryAfterMs,
      };
    }
    return await this.wake({ sessionId: input.sessionId, reason: 'check_now' });
  }

  async wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'check_now' }>): Promise<Readonly<{ status: string }>> {
    return await this.scheduler.wake(input);
  }

  private async recoverUsageLimitIntent(
    checking: UsageLimitRecoveryIntent,
    context: Readonly<{ sessionId: string }>,
  ) {
    const recovery = this.deps.recover
      ? await this.deps.recover(checking, { sessionId: context.sessionId })
      : { status: 'wait' as const, nextCheckAtMs: checking.nextCheckAtMs ?? checking.resetAtMs ?? this.deps.nowMs() };

    if (recovery.status === 'ready') {
      const succeeded: UsageLimitRecoveryIntent = {
        ...checking,
        status: 'cancelled',
        selectedAuth: recovery.selectedAuth ?? checking.selectedAuth,
      };
      if (readResumePromptMode(succeeded.resumePromptMode) === 'off') {
        return {
          status: 'success' as const,
          intent: succeeded,
          wakeResult: { status: 'ready' },
        };
      }
      // O4: resolve agentId when a resolver is provided (e.g. codex app-server knows its agentId);
      // fall back to null for inactive-session schedulers that don't have agent context.
      const resolvedAgentId = this.deps.resolveAgentId
        ? this.deps.resolveAgentId(context.sessionId)
        : null;
      recordConnectedServiceDaemonRestartDiagnostic({
        diagnostic: {
          trigger: 'usage_limit_recovery',
          sessionId: context.sessionId,
          agentId: resolvedAgentId,
          serviceId: readUsageLimitRecoveryServiceId(succeeded.selectedAuth),
          profileId: readUsageLimitRecoveryProfileId(succeeded.selectedAuth),
          groupId: readUsageLimitRecoveryGroupId(succeeded.selectedAuth),
          reason: succeeded.issueFingerprint,
        },
        status: 'requested',
        nowMs: this.deps.nowMs,
        recordRestartDiagnostic: this.deps.recordRestartDiagnostic,
      });
      await this.deps.resume?.(succeeded);
      return {
        status: 'success' as const,
        intent: succeeded,
        wakeResult: { status: 'resumed' },
      };
    }

    if (recovery.status === 'exhausted') {
      return {
        status: 'exhausted' as const,
        intent: checking,
        lastError: recovery.lastProbeError ?? null,
      };
    }

    if (recovery.status === 'superseded') {
      return {
        status: 'terminal' as const,
        intent: checking,
        lastError: recovery.lastProbeError ?? null,
      };
    }

    if (recovery.status === 'failed') {
      return {
        status: 'exhausted' as const,
        intent: checking,
        lastError: recovery.lastProbeError ?? recovery.errorCode ?? recovery.resultStatus,
        wakeResult: {
          status: recovery.resultStatus,
          ...(recovery.errorCode ? { errorCode: recovery.errorCode } : {}),
          ...(recovery.details ?? {}),
        },
      };
    }

    return {
      status: 'wait' as const,
      nextRetryAtMs: recovery.nextCheckAtMs,
      intent: recovery.selectedAuth
        ? {
            ...checking,
            selectedAuth: recovery.selectedAuth,
          }
        : checking,
      lastError: recovery.lastProbeError ?? null,
    };
  }
}
