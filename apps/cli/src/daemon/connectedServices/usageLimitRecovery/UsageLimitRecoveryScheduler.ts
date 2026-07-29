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
  hasSameUsageLimitRecoveryIdentity,
  mergeUsageLimitRecoveryIntent,
  mergeUsageLimitRecoveryRearm,
  mergeUsageLimitRecoverySchedule,
} from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';
import {
  recordConnectedServiceDaemonRestartDiagnostic,
  type ConnectedServiceDaemonRestartDiagnosticRecorder,
} from '../sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import {
  DurableBackoffRecoveryScheduler,
  type DurableBackoffRecoveryStore,
  type DurableRecoveryGateResult,
} from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import { deterministicStringify } from '@/utils/deterministicJson';

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

export type UsageLimitRecoveryCancelExactResult =
  | Readonly<{ status: 'cancelled'; intent: UsageLimitRecoveryIntent }>
  | Readonly<{ status: 'superseded'; intent: UsageLimitRecoveryIntent }>
  | Readonly<{ status: 'missing' }>;

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
export class UsageLimitRecoveryScheduler {
  private readonly checkNowRateLimiter: UsageLimitCheckNowRateLimiter;
  private readonly scheduler: DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>;

  constructor(private readonly deps: Readonly<{
    nowMs: () => number;
    store?: DurableBackoffRecoveryStore<UsageLimitRecoveryIntent>;
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
      isSameIntentVersion: (left, right) => (
        hasSameUsageLimitRecoveryIdentity(left, right)
        && deterministicStringify(left) === deterministicStringify(right)
      ),
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

  /** Reconstructs persisted state without scheduling or executing recovery. */
  hydratePassive(): ReadonlyArray<UsageLimitRecoveryIntent> {
    return this.scheduler.hydrate({ schedule: false });
  }

  load(input: Readonly<{
    sessionId: string;
    intent: UsageLimitRecoveryIntent;
  }>): UsageLimitRecoveryIntent {
    return this.scheduler.load(input);
  }

  async upsert(input: Readonly<{
    sessionId: string;
    intent: UsageLimitRecoveryIntent;
  }>): Promise<UsageLimitRecoveryIntent> {
    return await this.scheduler.upsert(input);
  }

  async upsertScheduled(input: Readonly<{
    sessionId: string;
    intent: UsageLimitRecoveryIntent;
  }>): Promise<UsageLimitRecoveryIntent> {
    return await this.scheduler.upsertMerged({
      sessionId: input.sessionId,
      intent: input.intent,
      merge: mergeUsageLimitRecoverySchedule,
    });
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

  async cancelExact(input: Readonly<{
    sessionId: string;
    issueFingerprint: string;
    armedAtMs: number;
    runtimeAuthRecoveryAttemptId?: string;
  }>): Promise<UsageLimitRecoveryCancelExactResult> {
    return await this.scheduler.transact<UsageLimitRecoveryCancelExactResult>({
      sessionId: input.sessionId,
      transaction: (current) => {
        if (!current) {
          return { intent: null, result: { status: 'missing' as const } };
        }
        if (!hasSameUsageLimitRecoveryIdentity(current, input)) {
          return {
            intent: current,
            result: { status: 'superseded' as const, intent: current },
          };
        }
        const cancelled = mergeUsageLimitRecoveryIntent(current, {
          ...current,
          status: 'cancelled',
          nextCheckAtMs: null,
        }) ?? {
          ...current,
          status: 'cancelled' as const,
          nextCheckAtMs: null,
        };
        return {
          intent: cancelled,
          result: { status: 'cancelled' as const, intent: cancelled },
        };
      },
    });
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
