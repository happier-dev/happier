import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID, SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { SessionUsageLimitRecoveryAuthSelectionV1, SessionUsageLimitRecoveryResumePromptModeV1, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import {
  hasSameUsageLimitRecoveryIdentity,
  isPendingUsageLimitRecoveryStatus,
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
import { PendingResetReconciliation, type PendingResetStartRecoveryPorts } from './pendingResetReconciliation';
export type { PendingResetStartDemand, PendingResetStartSessionPorts, PendingResetStartRecoveryPorts } from './pendingResetReconciliation';

export const RUNTIME_USAGE_LIMIT_RECOVERY_FIELD = SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID;
export const METADATA_SESSION_USAGE_LIMIT_RECOVERY_V1_KEY = SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY;

export type UsageLimitRecoveryIntent = SessionUsageLimitRecoveryV1;

export type UsageLimitRecoverySchedulerRecoveryResult =
  | Readonly<{ status: 'ready'; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1 }>
  | Readonly<{ status: 'resumed'; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1 }>
  | Readonly<{ status: 'pause'; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1 }>
  | Readonly<{ status: 'wait'; nextCheckAtMs: number | null; resetAtMs?: number | null; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1; lastProbeError?: string | null }>
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

function readUsageLimitRecoveryIntent(value: unknown): UsageLimitRecoveryIntent | null {
  const parsed = createStoredReadSchema(SessionUsageLimitRecoveryV1Schema).safeParse(value);
  return parsed.success ? { ...parsed.data, maxAttempts: 0 } : null;
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

function normalizeScheduledUsageLimitRecoveryIntent(intent: UsageLimitRecoveryIntent): UsageLimitRecoveryIntent {
  if (!isPendingUsageLimitRecoveryStatus(intent.status)) return intent;
  return {
    ...intent,
    status: intent.status === 'checking' ? 'waiting' : intent.status,
  };
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
  private readonly scheduler: DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>;
  private readonly pendingReset: PendingResetReconciliation;

  constructor(private readonly deps: Readonly<{
    nowMs: () => number;
    store?: DurableBackoffRecoveryStore<UsageLimitRecoveryIntent>;
    recover?: (intent: UsageLimitRecoveryIntent, context: Readonly<{ sessionId: string; reason: string }>) => Promise<UsageLimitRecoverySchedulerRecoveryResult>;
    resume?: (intent: UsageLimitRecoveryIntent) => Promise<void>;
    recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
    gate?: (input: Readonly<{ sessionId: string; intent: UsageLimitRecoveryIntent }>) => DurableRecoveryGateResult;
    /**
     * O4: optional resolver so callers with a known agent id (e.g. codex app-server) can
     * surface it in the restart diagnostic instead of leaving agentId null at the quota seam.
     */
    resolveAgentId?: (sessionId: string) => string | null;
    pendingResetStarts?: PendingResetStartRecoveryPorts;
  }>) {
    this.scheduler = new DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>({
      nowMs: deps.nowMs,
      store: deps.store,
      normalizeIntent: readUsageLimitRecoveryIntent,
      isSameIntentVersion: (left, right) => (
        hasSameUsageLimitRecoveryIdentity(left, right)
        && deterministicStringify(left) === deterministicStringify(right)
      ),
      getStatus: (intent) => intent.status === 'armed' ? 'waiting' : (
        intent.status === 'waiting'
        || intent.status === 'checking'
        || intent.status === 'cancelled'
        || intent.status === 'exhausted'
          ? intent.status
          : 'cancelled'
      ),
      getNextRetryAtMs: (intent) => intent.nextCheckAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: () => 0,
      // A readiness probe does not spend the continuation-attempt budget.
      markChecking: (intent) => ({
        ...intent,
        status: 'checking',
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
        nextCheckAtMs: null,
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
    this.pendingReset = new PendingResetReconciliation({ nowMs: deps.nowMs, ports: deps.pendingResetStarts, scheduler: this.scheduler });
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
      merge: (previous, next) => normalizeScheduledUsageLimitRecoveryIntent(
        mergeUsageLimitRecoverySchedule(previous, next),
      ),
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
    const intent: UsageLimitRecoveryIntent = {
      v: 1,
      issueFingerprint: input.issueFingerprint,
      status: 'waiting',
      resumePromptMode: readResumePromptMode(input.resumePromptMode),
      armedAtMs: nowMs,
      resetAtMs: input.resetAtMs,
      nextCheckAtMs: input.nextCheckAtMs === undefined ? input.resetAtMs : input.nextCheckAtMs,
      attemptCount: 0,
      maxAttempts: 0,
      lastProbeError: null,
      selectedAuth: input.selectedAuth,
    };
    // Merge instead of overwrite so a same-fingerprint resurfacing preserves attemptCount /
    // terminal (cancelled/exhausted) / next-check state rather than resetting the lifecycle to 0
    // and re-looping. Different fingerprint / no prior intent starts fresh.
    return await this.scheduler.upsertMerged({
      sessionId: input.sessionId,
      intent,
      merge: (previous, next) => normalizeScheduledUsageLimitRecoveryIntent(
        mergeUsageLimitRecoveryRearm(previous, next),
      ),
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
    // The canonical cancellation transaction also retires this exact intent's effect claim.
    let superseded: UsageLimitRecoveryIntent | null = null;
    const cancelled = await this.scheduler.cancel({
      sessionId: input.sessionId,
      matches: (current) => {
        if (hasSameUsageLimitRecoveryIdentity(current, input)) return true;
        superseded = current;
        return false;
      },
    });
    if (cancelled) return { status: 'cancelled', intent: cancelled };
    return superseded ? { status: 'superseded', intent: superseded } : { status: 'missing' };
  }

  async checkNow(input: Readonly<{ sessionId: string }>): Promise<Readonly<{
    status: string;
    errorCode?: string;
    retryAfterMs?: number;
  }>> {
    const current = this.read(input.sessionId);
    if (!current) return { status: 'inactive' };
    if (current.status === 'cancelled') return { status: 'inactive' };
    if (current.status === 'exhausted') return { status: 'exhausted' };
    if (current.status === 'paused') {
      await this.enable({
        sessionId: input.sessionId,
        issueFingerprint: current.issueFingerprint,
        resetAtMs: current.resetAtMs,
        nextCheckAtMs: this.deps.nowMs(),
        maxAttempts: current.maxAttempts,
        resumePromptMode: current.resumePromptMode,
        selectedAuth: current.selectedAuth,
      });
    }
    return await this.wake({ sessionId: input.sessionId, reason: 'check_now' });
  }

  async wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'check_now' }>): Promise<Readonly<{ status: string }>> {
    return await this.scheduler.wake(input);
  }

  /**
   * Retires this scheduler with the owner that created it: armed timers are cleared and later
   * wakes report `disposed` instead of claiming durable work. A machine-sync attempt that failed
   * hands its scheduler here before a replacement attempt hydrates the same durable store.
   */
  dispose(): void {
    this.pendingReset.dispose();
    this.scheduler.dispose();
  }

  /** Pending owns persistence; restart and every wake re-read the exact held rows. */
  async reconcilePendingResetStarts(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.pendingReset.reconcile(sessionId, signal);
  }

  async reconcilePendingResetStartsForTrackedSessions(signal?: AbortSignal): Promise<void> {
    await this.pendingReset.reconcileTracked(signal);
  }

  private async recoverUsageLimitIntent(
    checking: UsageLimitRecoveryIntent,
    context: Readonly<{ sessionId: string; reason: string }>,
  ) {
    let recovery: UsageLimitRecoverySchedulerRecoveryResult;
    try {
      recovery = this.deps.recover
        ? await this.deps.recover(checking, context)
        : { status: 'wait', nextCheckAtMs: checking.nextCheckAtMs };
    } catch {
      recovery = { status: 'wait', nextCheckAtMs: null,
        lastProbeError: 'usage_limit_recovery_readiness_probe_failed' };
    }

    if (recovery.status === 'pause' || (recovery.status === 'ready'
      && (readResumePromptMode(checking.resumePromptMode) === 'off' || !this.deps.resume))) {
      return {
        // Settle the existing durable claim without the success path converting paused to cancelled.
        status: 'pending' as const,
        intent: {
          ...checking,
          status: 'paused' as const,
          nextCheckAtMs: null,
          lastProbeError: null,
          selectedAuth: recovery.selectedAuth ?? checking.selectedAuth,
        },
        wakeResult: { status: 'ready' },
      };
    }

    if (recovery.status === 'ready' || recovery.status === 'resumed') {
      const succeeded: UsageLimitRecoveryIntent = {
        ...checking,
        status: 'cancelled',
        attemptCount: checking.attemptCount + 1,
        selectedAuth: recovery.selectedAuth ?? checking.selectedAuth,
      };
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
      try {
        if (recovery.status === 'ready') await this.deps.resume?.(succeeded);
      } catch {
        return {
          status: 'pending' as const,
          intent: { ...succeeded, status: 'waiting' as const, nextCheckAtMs: null,
            lastProbeError: 'session_usage_limit_recovery_resume_failed' },
          wakeResult: { status: 'waiting' },
        };
      }
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

    const nextCheckAtMs = recovery.nextCheckAtMs;
    const intent = { ...checking,
      resetAtMs: recovery.resetAtMs === undefined ? checking.resetAtMs : recovery.resetAtMs,
      selectedAuth: recovery.selectedAuth ?? checking.selectedAuth };
    if (nextCheckAtMs === null || nextCheckAtMs <= this.deps.nowMs()) {
      return {
        status: 'pending' as const,
        intent: { ...intent, status: 'waiting' as const, nextCheckAtMs: null,
          lastProbeError: recovery.lastProbeError ?? null },
        wakeResult: { status: 'waiting' },
      };
    }
    return {
      status: 'wait' as const,
      nextRetryAtMs: nextCheckAtMs,
      intent,
      lastError: recovery.lastProbeError ?? null,
    };
  }
}
