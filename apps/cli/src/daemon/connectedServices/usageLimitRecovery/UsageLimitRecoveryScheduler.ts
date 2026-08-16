import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID,
  SessionUsageLimitRecoveryV1Schema,
  type ConnectedServiceQuotaRecoveryCreditsV1,
  type SessionUsageLimitRecoveryAuthSelectionV1,
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
import {
  hasSameUsageLimitRecoveryIdentity,
  mergeUsageLimitRecoveryIntent,
  mergeUsageLimitRecoveryRearm,
  mergeUsageLimitRecoverySchedule,
} from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';
import {
  isRecoveredProviderOutcomeProof,
  type ProviderOutcomeProofKind,
} from '../recovery/providerOutcomeProof';

export const RUNTIME_USAGE_LIMIT_RECOVERY_FIELD = SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID;
export const METADATA_SESSION_USAGE_LIMIT_RECOVERY_V1_KEY = SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY;

export type UsageLimitRecoveryIntent = SessionUsageLimitRecoveryV1;

export type UsageLimitRecoverySchedulerRecoveryResult =
  | Readonly<{
      status: 'ready';
      selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1;
      recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1;
    }>
  | Readonly<{
      status: 'pause';
      selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1;
      recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1;
    }>
  | Readonly<{
      status: 'wait';
      nextCheckAtMs: number;
      lastProbeError?: string | null;
      selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1;
      recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1;
    }>
  | Readonly<{
      status: 'exhausted';
      lastProbeError?: string | null;
      recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1;
    }>
  /**
   * The probe proved the intent is stale (e.g. the interrupted turn later
   * completed normally): cancel terminally without resuming.
   */
  | Readonly<{ status: 'superseded'; lastProbeError?: string | null }>;

export type UsageLimitRecoveryIntentStore = Readonly<{
  read(sessionId: string): UsageLimitRecoveryIntent | unknown | null;
  readAll?: () => ReadonlyArray<readonly [sessionId: string, value: unknown]>;
  write(sessionId: string, intent: UsageLimitRecoveryIntent): Promise<void> | void;
  merge?: (
    sessionId: string,
    next: UsageLimitRecoveryIntent,
    merge: (previous: UsageLimitRecoveryIntent | null, next: UsageLimitRecoveryIntent) => UsageLimitRecoveryIntent | null,
  ) => Promise<UsageLimitRecoveryIntent | null> | UsageLimitRecoveryIntent | null;
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

function isPendingUsageLimitRecoveryStatus(status: UsageLimitRecoveryIntent['status']): boolean {
  return status === 'armed' || status === 'waiting' || status === 'checking';
}

function usageLimitRecoverySelectedAuthMatchesIdentity(input: Readonly<{
  selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
}>): boolean {
  if (input.selectedAuth.kind === 'native') return false;
  if (input.selectedAuth.serviceId !== input.serviceId) return false;
  if (input.selectedAuth.kind === 'group') {
    return input.selectedAuth.groupId === input.groupId;
  }
  return input.groupId === null && input.selectedAuth.profileId === input.profileId;
}

const DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS = 3;
const DEFAULT_USAGE_LIMIT_RECOVERY_TERMINAL_RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Merge a freshly-armed usage-limit intent against any prior intent.
 *
 * Same fingerprint => the issue resurfaced; preserve the existing lifecycle (attemptCount,
 * terminal/exhausted, cancelled, and next-retry timing) so backoff/dead-letter convergence
 * is not defeated by repeatedly re-arming at attemptCount 0. We still adopt the latest
 * selected auth so a candidate that changed out-of-band is honored.
 *
 * Different fingerprint (or no prior) => a genuinely new issue; start fresh from `next`.
 */
function resolveUsageLimitRecoveryPruneReferenceMs(intent: UsageLimitRecoveryIntent): number {
  return Math.max(
    intent.armedAtMs,
    intent.resetAtMs ?? 0,
    intent.nextCheckAtMs ?? 0,
  );
}

export class UsageLimitRecoveryScheduler {
  private readonly scheduler: DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>;
  private readonly checkNowRateLimiter: UsageLimitCheckNowRateLimiter;

  constructor(private readonly deps: Readonly<{
    nowMs: () => number;
    store?: UsageLimitRecoveryIntentStore;
    recover?: (
      intent: UsageLimitRecoveryIntent,
      context: Readonly<{ sessionId: string; reason: string }>,
    ) => Promise<UsageLimitRecoverySchedulerRecoveryResult>;
    resume?: (intent: UsageLimitRecoveryIntent) => Promise<void>;
    recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
    checkNowThrottleMs?: number;
    gate?: (input: Readonly<{ sessionId: string; intent: UsageLimitRecoveryIntent }>) => DurableRecoveryGateResult;
  }>) {
    this.checkNowRateLimiter = new UsageLimitCheckNowRateLimiter({
      nowMs: deps.nowMs,
      throttleMs: deps.checkNowThrottleMs,
    });
    this.scheduler = new DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>({
      nowMs: deps.nowMs,
      store: deps.store,
      normalizeIntent: (value) => isUsageLimitRecoveryIntent(value) ? value : null,
      getStatus: (intent) => intent.status === 'armed'
        ? 'waiting'
        : intent.status === 'paused'
        ? 'cancelled'
        : intent.status,
      getNextRetryAtMs: (intent) => intent.nextCheckAtMs ?? intent.resetAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      terminalRecordRetentionMs: DEFAULT_USAGE_LIMIT_RECOVERY_TERMINAL_RECORD_RETENTION_MS,
      getTerminalPruneReferenceMs: resolveUsageLimitRecoveryPruneReferenceMs,
      exhaustOnMaxAttemptOutcome: false,
      gate: deps.gate,
      markChecking: (intent, attemptCount) => ({
        ...intent,
        status: 'checking',
        attemptCount,
      }),
      markWaiting: (intent, input) => ({
        ...intent,
        status: 'waiting',
        nextCheckAtMs: input.nextRetryAtMs,
        lastProbeError: input.lastError,
      }),
      markCancelled: (intent) => ({
        ...intent,
        status: 'cancelled',
        nextCheckAtMs: null,
      }),
      markExhausted: (intent, input) => ({
        ...intent,
        status: 'exhausted',
        lastProbeError: input.lastError,
      }),
      recover: async (intent, context) => {
        const recovery = deps.recover
          ? await deps.recover(intent, { sessionId: context.sessionId, reason: context.reason })
          : { status: 'wait' as const, nextCheckAtMs: intent.nextCheckAtMs ?? intent.resetAtMs ?? deps.nowMs() };
        if (recovery.status === 'ready') {
          const recoveryCredits = recovery.recoveryCredits ?? intent.recoveryCredits;
          const succeeded: UsageLimitRecoveryIntent = {
            ...intent,
            status: 'cancelled',
            selectedAuth: recovery.selectedAuth ?? intent.selectedAuth,
            ...(recoveryCredits ? { recoveryCredits } : {}),
          };
          recordConnectedServiceDaemonRestartDiagnostic({
            diagnostic: {
              trigger: 'usage_limit_recovery',
              sessionId: context.sessionId,
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
            status: 'success',
            intent: succeeded,
          };
        }
        if (recovery.status === 'pause') {
          const recoveryCredits = recovery.recoveryCredits ?? intent.recoveryCredits;
          return {
            status: 'success',
            intent: {
              ...intent,
              status: 'paused',
              nextCheckAtMs: null,
              lastProbeError: null,
              selectedAuth: recovery.selectedAuth ?? intent.selectedAuth,
              ...(recoveryCredits ? { recoveryCredits } : {}),
            },
          };
        }
        if (recovery.status === 'exhausted') {
          return {
            status: 'exhausted',
            lastError: recovery.lastProbeError ?? null,
          };
        }
        if (recovery.status === 'superseded') {
          return {
            status: 'terminal',
            lastError: recovery.lastProbeError ?? null,
          };
        }
        const recoveryCredits = recovery.recoveryCredits ?? intent.recoveryCredits;
        return {
          status: 'wait',
          nextRetryAtMs: recovery.nextCheckAtMs,
          lastError: recovery.lastProbeError ?? null,
          intent: {
            ...intent,
            status: 'waiting' as const,
            nextCheckAtMs: recovery.nextCheckAtMs,
            lastProbeError: recovery.lastProbeError ?? null,
            selectedAuth: recovery.selectedAuth ?? intent.selectedAuth,
            ...(recoveryCredits ? { recoveryCredits } : {}),
          },
        };
      },
    });
  }

  read(sessionId: string): UsageLimitRecoveryIntent | null {
    return this.scheduler.readByKeyPassive(sessionId);
  }

  hydrate(): ReadonlyArray<UsageLimitRecoveryIntent> {
    return this.scheduler.hydrate();
  }

  /** Reconstructs persisted recovery state for display/manual control without timers or effects. */
  hydratePassive(): ReadonlyArray<UsageLimitRecoveryIntent> {
    return this.scheduler.hydratePassive();
  }

  async enable(input: Readonly<{
    sessionId: string;
    issueFingerprint: string;
    resetAtMs: number | null;
    nextCheckAtMs?: number | null;
    maxAttempts?: number;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1;
    recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1;
  }>): Promise<UsageLimitRecoveryIntent> {
    const nowMs = this.deps.nowMs();
    const maxAttempts = typeof input.maxAttempts === 'number' && Number.isFinite(input.maxAttempts)
      ? Math.max(0, Math.trunc(input.maxAttempts))
      : DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS;
    const previous = this.read(input.sessionId);
    const resumePromptMode = input.resumePromptMode
      ?? (previous?.issueFingerprint === input.issueFingerprint ? previous.resumePromptMode : undefined)
      ?? 'standard';
    // A fresh lifecycle is ordered at its creation owner. Millisecond timestamps are
    // not unique, and opaque issue fingerprints must never be used as chronology.
    const intent: UsageLimitRecoveryIntent = {
      v: 1,
      issueFingerprint: input.issueFingerprint,
      status: 'waiting',
      armedAtMs: nowMs,
      resetAtMs: input.resetAtMs,
      nextCheckAtMs: input.nextCheckAtMs ?? input.resetAtMs,
      attemptCount: 0,
      maxAttempts,
      lastProbeError: null,
      resumePromptMode,
      selectedAuth: input.selectedAuth,
      ...(input.recoveryCredits ? { recoveryCredits: input.recoveryCredits } : {}),
    };
    // Merge against any existing intent so a same-fingerprint resurfacing converges with the
    // existing backoff/dead-letter lifecycle instead of resetting attemptCount to 0 every time.
    // A genuinely new issue (different reset bucket/fingerprint) starts fresh.
    const merged = await this.scheduler.upsertMerged({
      sessionId: input.sessionId,
      intent,
      merge: mergeUsageLimitRecoveryRearm,
    });
    return merged;
  }

  async upsert(input: Readonly<{
    sessionId: string;
    intent: UsageLimitRecoveryIntent;
  }>): Promise<UsageLimitRecoveryIntent> {
    await this.scheduler.upsert({ sessionId: input.sessionId, intent: input.intent });
    return input.intent;
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

  async cancel(input: Readonly<{ sessionId: string }>): Promise<UsageLimitRecoveryIntent | null> {
    return await this.scheduler.cancel(input);
  }

  async cancelExact(input: Readonly<{
    sessionId: string;
    issueFingerprint: string;
    armedAtMs: number;
    runtimeAuthRecoveryAttemptId?: string;
  }>): Promise<UsageLimitRecoveryCancelExactResult> {
    const observed = this.read(input.sessionId);
    if (!observed) return { status: 'missing' };
    const settlement = await this.scheduler.upsertConditionallyByKey({
      sessionId: input.sessionId,
      recoveryKey: input.sessionId,
      intent: { ...observed, status: 'cancelled', nextCheckAtMs: null },
      expectedCurrent: (current) => hasSameUsageLimitRecoveryIdentity(current, input),
      merge: (current) => ({ ...current, status: 'cancelled', nextCheckAtMs: null }),
    });
    if (settlement.status === 'settled') {
      return { status: 'cancelled', intent: settlement.intent };
    }
    return settlement.intent
      ? { status: 'superseded', intent: settlement.intent }
      : { status: 'missing' };
  }

  async markProviderOutcomeProofForSession(input: Readonly<{
    sessionId: string;
    proofKind: ProviderOutcomeProofKind;
    serviceId: string;
    profileId?: string | null;
    groupId?: string | null;
    expectedRuntimeAuthRecoveryAttemptId?: string;
    observedAtMs?: number;
  }>): Promise<UsageLimitRecoveryIntent | null> {
    const intent = this.read(input.sessionId);
    if (!intent || !isRecoveredProviderOutcomeProof(input.proofKind)) return intent;
    if (!isPendingUsageLimitRecoveryStatus(intent.status)) return intent;
    if (
      typeof input.observedAtMs === 'number'
      && Number.isFinite(input.observedAtMs)
      && input.observedAtMs < intent.armedAtMs
    ) return intent;
    if (
      input.expectedRuntimeAuthRecoveryAttemptId !== undefined
      && intent.runtimeAuthRecoveryAttemptId !== input.expectedRuntimeAuthRecoveryAttemptId
    ) {
      return intent;
    }
    const profileId = typeof input.profileId === 'string' && input.profileId.trim().length > 0
      ? input.profileId.trim()
      : null;
    const groupId = typeof input.groupId === 'string' && input.groupId.trim().length > 0
      ? input.groupId.trim()
      : null;
    if (!usageLimitRecoverySelectedAuthMatchesIdentity({
      selectedAuth: intent.selectedAuth,
      serviceId: input.serviceId,
      profileId,
      groupId,
    })) {
      return intent;
    }
    const settlement = await this.cancelExact({
      sessionId: input.sessionId,
      issueFingerprint: intent.issueFingerprint,
      armedAtMs: intent.armedAtMs,
      ...(intent.runtimeAuthRecoveryAttemptId
        ? { runtimeAuthRecoveryAttemptId: intent.runtimeAuthRecoveryAttemptId }
        : {}),
    });
    return settlement.status === 'missing' ? null : settlement.intent;
  }

  async checkNow(input: Readonly<{ sessionId: string }>): Promise<Readonly<{
    status: string;
    errorCode?: string;
    retryAfterMs?: number;
  }>> {
    const current = this.read(input.sessionId);
    // A normal fresh prompt may opportunistically ask the canonical owner to reopen recovery.
    // With no lifecycle there is nothing to probe, so do not spend the user's probe budget.
    if (!current) return { status: 'inactive' };
    // Once a lifecycle exists, every explicit probe attempt shares the same throttle even when
    // the preceding attempt made it terminal. This prevents a rapid follow-up from bypassing the
    // provider-probe contract merely because the first attempt completed synchronously.
    const rateLimit = this.checkNowRateLimiter.check(input.sessionId);
    if (!rateLimit.allowed) {
      return {
        status: 'rate_limited',
        errorCode: USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
        retryAfterMs: rateLimit.retryAfterMs,
      };
    }
    if (current.status === 'cancelled') return { status: 'inactive' };
    if (current.status === 'exhausted') return { status: 'exhausted' };
    if (current?.status === 'paused') {
      // `paused` is deliberately terminal for timer/startup wakes. A check-now call is the
      // separate, explicit user-authorized transition which may re-arm that exact issue.
      // Reuse the canonical enable/merge owner so paused-vs-cancelled semantics remain singular.
      await this.enable({
        sessionId: input.sessionId,
        issueFingerprint: current.issueFingerprint,
        resetAtMs: current.resetAtMs,
        nextCheckAtMs: this.deps.nowMs(),
        maxAttempts: current.maxAttempts,
        resumePromptMode: current.resumePromptMode,
        selectedAuth: current.selectedAuth,
        ...(current.recoveryCredits ? { recoveryCredits: current.recoveryCredits } : {}),
      });
    }
    return await this.wake({ sessionId: input.sessionId, reason: 'check_now' });
  }

  async wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'check_now' }>): Promise<Readonly<{ status: string }>> {
    const result = await this.scheduler.wake(input);
    if (result.status !== 'succeeded') return result;
    return this.read(input.sessionId)?.status === 'paused'
      ? { status: 'ready' }
      : { status: 'resumed' };
  }
}
