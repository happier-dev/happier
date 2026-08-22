import { classifyDaemonServerWorkError } from '@/daemon/serverWork';
import type {
  DaemonServerWorkErrorClassification,
  DaemonServerWorkErrorKind,
} from '@/daemon/serverWork/types';
import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceUxDiagnosticV1,
} from '@happier-dev/protocol';

import { buildConnectedServiceUxDiagnostic } from '../diagnostics/connectedServiceUxDiagnostics';
import {
  DurableBackoffRecoveryScheduler,
  type DurableBackoffRecoveryStore,
} from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import {
  isRecoveredProviderOutcomeProof,
  isTerminalProviderOutcomeProof,
  type ProviderOutcomeProofKind,
} from '../recovery/providerOutcomeProof';
import {
  isLocallyCompleteWithoutProof,
  isProvenRuntimeAuthRecoverySuccess,
  readRuntimeAuthRecoverySwitchResult,
  resolveRuntimeAuthRecoveryProof,
} from './resolveRuntimeAuthRecoveryOutcome';
import { resolveRuntimeAuthRecoveryResultDisposition } from './resolveRuntimeAuthRecoveryResultDisposition';
import { sanitizeConnectedServiceDiagnosticString } from './sanitizeConnectedServiceDiagnosticString';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './sanitizeConnectedServiceRuntimeFailureClassification';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { readConnectedServiceAuthGenerationApplyFailure } from './connectedServiceAuthGenerationApplyFailure';
import {
  buildRuntimeAuthRecoveryKey,
  type RuntimeAuthRecoveryKeyParts,
} from './runtimeAuthRecoveryKey';
import {
  buildRuntimeAuthRecoveryScheduledUxDiagnostic,
  buildRuntimeAuthRecoveryTranscriptEvent,
  type ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1,
} from './projection/connectedServiceRuntimeAuthRecoveryProjection';

type RuntimeAuthRecoveryStatus = 'waiting' | 'checking' | 'resumed_awaiting_proof' | 'cancelled' | 'exhausted' | 'recovered';
type RuntimeAuthRecoveryPhase = 'handler' | 'apply';
export type RuntimeAuthRecoveryTransition = 'working' | 'scheduled' | 'terminal' | 'recovered';

export type RuntimeAuthRecoveryPendingVisibleEvent = Readonly<{
  attemptId: string;
  transition: RuntimeAuthRecoveryTransition;
  transcriptEvent: ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1;
}>;

export type RuntimeAuthRecoveryVisibleEventDelivery = RuntimeAuthRecoveryPendingVisibleEvent & Readonly<{
  sessionId: string;
}>;

const RUNTIME_AUTH_RECOVERY_UNPROVEN_PROVIDER_OUTCOME_ERROR = 'recovery_unproven_awaiting_provider_outcome';

export type RuntimeAuthRecoveryIntent = Readonly<{
  v: 1;
  attemptId?: string;
  lastSettledTransition?: RuntimeAuthRecoveryTransition;
  pendingVisibleEvents?: ReadonlyArray<RuntimeAuthRecoveryPendingVisibleEvent>;
  sessionId: string;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  resumePromptMode?: 'standard' | 'off' | 'custom';
  status: RuntimeAuthRecoveryStatus;
  armedAtMs: number;
  failurePhase: RuntimeAuthRecoveryPhase;
  failureReason: string;
  classification: ConnectedServiceRuntimeFailureClassification;
  switchesThisTurn: number;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAtMs: number | null;
  lastError: string | null;
  lastErrorClassification: DaemonServerWorkErrorClassification | null;
  pendingTargetProfileId?: string | null;
  pendingTargetGeneration?: number | null;
  pendingTargetCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  terminalAtMs?: number | null;
  terminalReason?: string | null;
  // S2: separate bounded budget for DEGRADED endpoint/lifecycle retries so a long local
  // outage does not consume the normal `attemptCount` budget and dead-letter a recoverable
  // session faster than a real provider failure.
  degradedAttemptCount?: number;
  // Bounded budget for COALESCED stale-profile replays (same pending proof target, no proof
  // yet): each coalesced replay rolls the attempt increment back, so without a bound the
  // switch pipeline would re-run forever for an idle session.
  coalescedReplayCount?: number;
}>;

export type RuntimeAuthRecoveryDiagnostic = Readonly<{
  event:
    | 'runtime_auth_recovery_enqueue'
    | 'runtime_auth_recovery_retry'
    | 'runtime_auth_recovery_success'
    | 'runtime_auth_recovery_terminal'
    | 'runtime_auth_recovery_delayed'
    | 'runtime_auth_recovery_dead_letter'
    | 'runtime_auth_recovery_superseded';
  sessionId: string;
  serviceId?: string | null;
  groupId?: string | null;
  profileId?: string | null;
  failurePhase?: RuntimeAuthRecoveryPhase;
  attemptCount?: number;
  nextRetryAtMs?: number | null;
  reason?: string | null;
  errorClassification?: DaemonServerWorkErrorClassification | null;
  /**
   * The ORIGINAL runtime failure kind (e.g. `usage_limit`) before it is mapped to a
   * `DaemonServerWorkErrorClassification` retry class (`usage_limit` → `rate_limited`). Carried
   * alongside the mapped `errorClassification` so log readers see the real cause: the mapped-only
   * view renamed `usage_limit` to `rate_limited` and misled a live investigation (2026-07-10). The
   * retry class mapping itself is unchanged — this is diagnostics only.
   */
  failureKind?: ConnectedServiceRuntimeFailureClassification['kind'];
  uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
  transcriptEvent?: ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1;
}>;

export type RuntimeAuthRecoveryScheduleResult =
  | Readonly<{
      status: 'scheduled';
      retryable: true;
      nextRetryAtMs: number;
      attemptCount: number;
      maxAttempts: number;
      attemptId?: string;
      transition?: RuntimeAuthRecoveryTransition;
      resumePromptMode?: 'standard' | 'off' | 'custom';
    }>
  | Readonly<{
      status: 'terminal_non_retry';
      retryable: false;
      reason: string;
      errorClassification?: DaemonServerWorkErrorClassification | null;
    }>;

export type RuntimeAuthRecoverySchedulerLike = Readonly<{
  beginClassifiedFailure(input: Readonly<{
    reportId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>): Promise<RuntimeAuthRecoveryScheduleResult>;
  enqueueHandlerFailure(input: Readonly<{
    reportId?: string;
    expectedAttemptId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    error: unknown;
  }>): Promise<RuntimeAuthRecoveryScheduleResult>;
  enqueueApplyFailure(input: Readonly<{
    reportId?: string;
    expectedAttemptId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    result: unknown;
  }>): Promise<RuntimeAuthRecoveryScheduleResult>;
  read(sessionId: string): RuntimeAuthRecoveryIntent | null;
  readForSession(sessionId: string): ReadonlyArray<RuntimeAuthRecoveryIntent>;
  wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'manual' }>): Promise<Readonly<{ status: string }>>;
  cancel(input: Readonly<{ sessionId: string }>): Promise<RuntimeAuthRecoveryIntent | null>;
  cancelExact(input: Readonly<{ sessionId: string; attemptId: string }>): Promise<ReadonlyArray<RuntimeAuthRecoveryIntent>>;
  cancelByKey(input: RuntimeAuthRecoveryKeyParts): Promise<RuntimeAuthRecoveryIntent | null>;
  rearmAfterConfirmedEffectOwnerLossByKey?(
    input: RuntimeAuthRecoveryKeyParts & Readonly<{
      authorization: 'fresh_user_action_after_owner_loss';
    }>,
  ): Promise<RuntimeAuthRecoveryIntent | null>;
  markSucceededByKey(
    input: RuntimeAuthRecoveryKeyParts & Readonly<{ expectedAttemptId?: string }>,
  ): Promise<RuntimeAuthRecoveryIntent | null>;
  markAwaitingProviderOutcomeProofByKey?: (
    input: RuntimeAuthRecoveryKeyParts & Readonly<{ expectedAttemptId?: string; result?: unknown }>,
  ) =>
    Promise<RuntimeAuthRecoveryIntent | null>;
  settleResultByKey?: (
    input: RuntimeAuthRecoveryKeyParts & Readonly<{
      expectedAttemptId?: string;
      result: unknown;
      classificationResetsAtMs: number | null;
      classificationFailureKind: ConnectedServiceRuntimeFailureClassification['kind'];
    }>,
  ) => Promise<RuntimeAuthRecoveryIntent | null>;
  markProviderOutcomeProofByIdentity?: (input: RuntimeAuthRecoveryProofByIdentityInput) =>
    Promise<ReadonlyArray<RuntimeAuthRecoveryIntent>>;
  drainPendingVisibleEvents?: (
    deliver: (delivery: RuntimeAuthRecoveryVisibleEventDelivery) => Promise<void>,
  ) => Promise<number>;
  dispose?: () => void;
}>;

export type RuntimeAuthRecoveryProofByIdentityInput = Readonly<{
  sessionId: string;
  proofKind: ProviderOutcomeProofKind;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  groupGeneration?: number | null;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  observedAtMs?: number;
}>;

const DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS = 3;
const DEFAULT_RUNTIME_AUTH_RECOVERY_BASE_BACKOFF_MS = 1_000;
const DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_BACKOFF_MS = 60_000;
const DEFAULT_RUNTIME_AUTH_RECOVERY_TERMINAL_RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;
// S2: a long local-endpoint/lifecycle outage must be waited out (re-driven on each wake) on a
// separate, much larger budget than the normal provider-failure attempt budget, while staying
// bounded so it never waits forever.
const DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_DEGRADED_ATTEMPTS = 60;
const DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_COALESCED_REPLAYS = 12;
const DEFAULT_RUNTIME_AUTH_RECOVERY_DEGRADED_BACKOFF_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function isRuntimeAuthRecoveryStatus(value: unknown): value is RuntimeAuthRecoveryStatus {
  return value === 'waiting'
    || value === 'checking'
    || value === 'resumed_awaiting_proof'
    || value === 'cancelled'
    || value === 'exhausted'
    || value === 'recovered';
}

function isRuntimeAuthRecoveryPhase(value: unknown): value is RuntimeAuthRecoveryPhase {
  return value === 'handler' || value === 'apply';
}

function isServerWorkErrorClassification(value: unknown): value is DaemonServerWorkErrorClassification {
  const record = asRecord(value);
  return Boolean(record)
    && typeof record?.kind === 'string'
    && typeof record?.retryable === 'boolean';
}

export function normalizeRuntimeAuthRecoveryIntent(value: unknown): RuntimeAuthRecoveryIntent | null {
  const record = asRecord(value);
  if (!record || record.v !== 1) return null;
  if (!isRuntimeAuthRecoveryStatus(record.status)) return null;
  if (!isRuntimeAuthRecoveryPhase(record.failurePhase)) return null;
  if (typeof record.switchesThisTurn !== 'number' || !Number.isFinite(record.switchesThisTurn)) return null;
  if (typeof record.attemptCount !== 'number' || !Number.isFinite(record.attemptCount)) return null;
  if (typeof record.maxAttempts !== 'number' || !Number.isFinite(record.maxAttempts)) return null;
  if (record.nextRetryAtMs !== null && typeof record.nextRetryAtMs !== 'number') return null;
  const classification = sanitizeConnectedServiceRuntimeFailureClassification(record.classification);
  if (!classification) return null;
  if (record.lastError !== null && typeof record.lastError !== 'string') return null;
  if (record.lastErrorClassification !== null && !isServerWorkErrorClassification(record.lastErrorClassification)) {
    return null;
  }
  const pendingVisibleEvents = Array.isArray(record.pendingVisibleEvents)
    ? record.pendingVisibleEvents.flatMap((candidate): RuntimeAuthRecoveryPendingVisibleEvent[] => {
        const pending = asRecord(candidate);
        const attemptId = readString(pending?.attemptId);
        const transition = pending?.transition === 'working' || pending?.transition === 'scheduled'
          || pending?.transition === 'terminal' || pending?.transition === 'recovered'
          ? pending.transition
          : null;
        const transcriptEvent = asRecord(pending?.transcriptEvent);
        if (!attemptId || !transition || transcriptEvent?.type !== 'connected-service-runtime-auth-recovery') return [];
        return [{
          attemptId,
          transition,
          transcriptEvent: pending?.transcriptEvent as ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1,
        }];
      })
    : [];
  return {
    ...(record as unknown as RuntimeAuthRecoveryIntent),
    ...(readString(record.attemptId) ? { attemptId: readString(record.attemptId) as string } : {}),
    ...(record.lastSettledTransition === 'working' || record.lastSettledTransition === 'scheduled' || record.lastSettledTransition === 'terminal' || record.lastSettledTransition === 'recovered'
      ? { lastSettledTransition: record.lastSettledTransition }
      : {}),
    ...(pendingVisibleEvents.length > 0 ? { pendingVisibleEvents } : {}),
    sessionId: readString(record.sessionId) ?? '',
    serviceId: readString(record.serviceId) ?? classification.serviceId,
    profileId: readString(record.profileId) ?? classification.profileId,
    groupId: readString(record.groupId) ?? classification.groupId,
    resumePromptMode: record.resumePromptMode === 'off' || record.resumePromptMode === 'custom'
      ? record.resumePromptMode
      : 'standard',
    classification,
    armedAtMs: typeof record.armedAtMs === 'number' && Number.isFinite(record.armedAtMs)
      ? Math.trunc(record.armedAtMs)
      : 0,
    failureReason: readString(record.failureReason) ?? (
      record.failurePhase === 'handler' ? 'handler_transient_failure' : 'apply_transient_failure'
    ),
    pendingTargetProfileId: record.pendingTargetProfileId === undefined || record.pendingTargetProfileId === null
      ? null
      : readString(record.pendingTargetProfileId),
    pendingTargetGeneration: record.pendingTargetGeneration === undefined || record.pendingTargetGeneration === null
      ? null
      : typeof record.pendingTargetGeneration === 'number' && Number.isFinite(record.pendingTargetGeneration)
        ? Math.max(0, Math.trunc(record.pendingTargetGeneration))
        : null,
    pendingTargetCredentialRevision: record.pendingTargetCredentialRevision === undefined
      || record.pendingTargetCredentialRevision === null
      ? null
      : (ConnectedServiceCredentialRevisionV1Schema.safeParse(record.pendingTargetCredentialRevision).data ?? null),
    terminalAtMs: record.terminalAtMs === undefined || record.terminalAtMs === null
      ? null
      : typeof record.terminalAtMs === 'number' && Number.isFinite(record.terminalAtMs)
        ? Math.trunc(record.terminalAtMs)
        : null,
    terminalReason: record.terminalReason === undefined || record.terminalReason === null
      ? null
      : readString(record.terminalReason),
    ...(typeof record.degradedAttemptCount === 'number'
      && Number.isFinite(record.degradedAttemptCount)
      && record.degradedAttemptCount >= 0
      ? { degradedAttemptCount: Math.trunc(record.degradedAttemptCount) }
      : {}),
    ...(typeof record.coalescedReplayCount === 'number'
      && Number.isFinite(record.coalescedReplayCount)
      && record.coalescedReplayCount >= 0
      ? { coalescedReplayCount: Math.trunc(record.coalescedReplayCount) }
      : {}),
  };
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return sanitizeConnectedServiceDiagnosticString(error.message);
  if (typeof error === 'string' && error.trim()) return sanitizeConnectedServiceDiagnosticString(error);
  return null;
}

function isTerminalRuntimeFailureClassification(
  classification: ConnectedServiceRuntimeFailureClassification,
): boolean {
  return classification.kind === 'validation'
    || classification.kind === 'account_disabled'
    || classification.kind === 'permission_denied'
    || classification.kind === 'plan';
}

function readSwitchAttemptResultStatus(result: unknown): string | null {
  const outer = asRecord(result);
  const inner = asRecord(outer?.result);
  return readString(inner?.status) ?? readString(outer?.status);
}

function resolveRuntimeAuthRecoveryDisposition(input: Readonly<{
  result: unknown;
  intent: RuntimeAuthRecoveryIntent;
  nowMs: number;
}>) {
  return resolveRuntimeAuthRecoveryResultDisposition({
    result: input.result,
    classificationFailureKind: input.intent.classification.kind,
    classificationResetsAtMs: input.intent.classification.resetsAtMs ?? null,
    additionalWaitCandidatesMs: [input.intent.nextRetryAtMs],
    nowMs: input.nowMs,
  });
}

function resolveClassifiedFailureRetryAfterMs(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  nowMs: number;
}>): number | undefined {
  const retryAfterMs = input.classification.retryAfterMs;
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)) {
    return Math.max(0, Math.trunc(retryAfterMs));
  }
  const resetsAtMs = input.classification.resetsAtMs;
  if (typeof resetsAtMs === 'number' && Number.isFinite(resetsAtMs) && resetsAtMs > input.nowMs) {
    return Math.max(0, Math.trunc(resetsAtMs - input.nowMs));
  }
  return undefined;
}

function mapRuntimeFailureKindToDaemonWorkErrorKind(
  kind: ConnectedServiceRuntimeFailureClassification['kind'],
): DaemonServerWorkErrorKind {
  switch (kind) {
    case 'auth_expired':
    case 'refresh_failed':
    case 'account_changed':
    case 'permission_denied':
    case 'account_disabled':
      return 'auth_failed';
    case 'usage_limit':
    case 'rate_limit':
    case 'temporary_throttle':
      return 'rate_limited';
    case 'dependency_failure':
      return 'dependency_unavailable';
    case 'capacity':
      return 'server_error';
    case 'validation':
      return 'client_error';
    case 'plan':
    case 'unknown':
      return 'protocol_error';
  }
}

// Provider-outcome proof gate. A switch event, auth-store adoption, credential
// refresh, observed-generation bump, or restart request is a recovery PHASE, not
// proof the provider can authenticate. Recovery is cleared as recovered only with
// deterministic proof (verified account adoption, or a genuinely fresh candidate)
// — see resolveRuntimeAuthRecoveryOutcome. Local-only completions
// (credential_refreshed, generic ok:true, unverified switch / observed_generation)
// are NOT success; they are intermediate and stay pending under the backoff
// lifecycle (see isLocallyCompleteWithoutProof in recover()).
function isSuccessfulRecoveryResult(result: unknown): boolean {
  return isProvenRuntimeAuthRecoverySuccess(result);
}

// Handler verdict: the replayed recovery no longer applies (e.g. the group already moved
// off the failing profile). The scheduler removes the durable record so the same key can
// re-arm on a genuine future failure — see `DurableBackoffRecoveryResult`'s `superseded`.
function readRuntimeAuthRecoverySupersededReason(result: unknown): string | null {
  const record = asRecord(result);
  if (!record || record.status !== 'recovery_superseded') return null;
  return readString(record.reason) ?? 'recovery_superseded';
}

function isTerminalRecoveryResult(result: unknown): boolean {
  return resolveTerminalRecoveryReason(result) !== null;
}

// HF-5 (A1-MED-1): a wake whose recovery armed the SAME-SESSION temporary backoff-resume path
// (or reported it unavailable) hands ownership to that path. The durable record must be removed
// with a SUPERSEDED outcome — never settled terminal by the unknown-status catch-all — so the
// key re-arms fresh on a genuine future failure.
function readTemporaryRetryWakeStatus(result: unknown): string | null {
  const status = asRecord(result)?.status;
  return status === 'temporary_retry_armed' || status === 'temporary_retry_unavailable'
    ? status
    : null;
}

function isUntargetedProviderOutcomeProofWaitRefresh(input: Readonly<{
  intent: RuntimeAuthRecoveryIntent;
  pendingTarget: RuntimeAuthPendingProofTarget | null;
}>): boolean {
  return input.intent.lastError === RUNTIME_AUTH_RECOVERY_UNPROVEN_PROVIDER_OUTCOME_ERROR
    && input.pendingTarget === null
    && input.intent.pendingTargetProfileId === null
    && input.intent.pendingTargetGeneration === null
    && input.intent.pendingTargetCredentialRevision === null;
}

function resolveTerminalRecoveryReason(result: unknown): string | null {
  const proof = resolveRuntimeAuthRecoveryProof(result);
  if (isTerminalProviderOutcomeProof(proof)) return proof;
  const status = readSwitchAttemptResultStatus(result);
  return status === 'recovery_action_required'
    || status === 'no_eligible_member'
    || status === 'policy_blocked'
    || status === 'invalid_credentials'
    || status === 'account_disabled'
    || status === 'validation_failed'
    || status === 'session_not_found'
    || status === 'switch_coordinator_unavailable'
    || status === 'ignored'
    ? status
    : null;
}

// S2: a degraded daemon-lifecycle / session-endpoint outage is a transient LOCAL condition, not a
// provider failure. It must keep the recovery WAITING (re-driven when the daemon/endpoint is
// healthy again) and must NOT be terminalized as a non-retryable result.
function isDegradedLifecycleRecoveryResult(result: unknown): boolean {
  const record = asRecord(result);
  if (!record) return false;
  return record.status === 'daemon_lifecycle_unavailable'
    || record.status === 'session_endpoint_unavailable';
}

function resolveDegradedReason(result: unknown): string {
  return asRecord(result)?.status === 'daemon_lifecycle_unavailable'
    ? 'recovery_deferred_shutdown'
    : 'session_endpoint_unavailable';
}

// Build the recover-loop outcome for a DEGRADED lifecycle/endpoint-unavailable result.
//
// The durable scheduler already incremented `attemptCount` (via markChecking) for this tick. A
// degraded outcome must NOT consume the normal attempt budget, so we roll `attemptCount` back to
// its pre-tick value and instead advance a separate, much larger `degradedAttemptCount` budget.
// This lets a long local outage be waited out (re-driven on every wake) without dead-lettering a
// recoverable session, while staying bounded: once the degraded budget is exhausted we surface an
// action-required terminal rather than waiting forever.
function buildDegradedRecoveryOutcome(input: Readonly<{
  intent: RuntimeAuthRecoveryIntent;
  reason: string;
  nowMs: number;
  maxDegradedAttempts: number;
  degradedBackoffMs: number;
}>): { status: 'wait'; nextRetryAtMs: number; lastError: string; intent: RuntimeAuthRecoveryIntent }
  | { status: 'terminal'; lastError: string; intent: RuntimeAuthRecoveryIntent } {
  const preTickAttemptCount = Math.max(0, input.intent.attemptCount - 1);
  const degradedAttemptCount = (input.intent.degradedAttemptCount ?? 0) + 1;
  if (degradedAttemptCount >= input.maxDegradedAttempts) {
    return {
      status: 'terminal',
      lastError: 'degraded_recovery_attempts_exhausted',
      intent: {
        ...input.intent,
        attemptCount: preTickAttemptCount,
        degradedAttemptCount,
      },
    };
  }
  return {
    status: 'wait',
    nextRetryAtMs: input.nowMs + input.degradedBackoffMs,
    lastError: input.reason,
    intent: {
      ...input.intent,
      attemptCount: preTickAttemptCount,
      degradedAttemptCount,
    },
  };
}

function readApplyFailureDiagnostics(result: unknown): Readonly<{
  errorCode: string | null;
  diagnostics: Record<string, unknown> | null;
}> {
  const outer = asRecord(result);
  const inner = asRecord(outer?.result);
  if (inner?.status === 'generation_apply_failed') {
    return {
      errorCode: readString(inner.errorCode),
      diagnostics: asRecord(inner.diagnostics),
    };
  }
  const applyResult = asRecord(inner?.applyResult);
  return {
    errorCode: readString(applyResult?.errorCode),
    diagnostics: asRecord(applyResult?.diagnostics),
  };
}

function readVerificationReason(diagnostics: Record<string, unknown> | null): string | null {
  return readString(asRecord(diagnostics?.verification)?.reason);
}

function isDurableContinuityReconstructionExhausted(diagnostics: Record<string, unknown> | null): boolean {
  const durableContinuity = asRecord(diagnostics?.durableContinuity);
  return diagnostics?.durableContinuityReconstructionExhausted === true
    || diagnostics?.reconstructionExhausted === true
    || durableContinuity?.status === 'exhausted'
    || durableContinuity?.reconstructionExhausted === true;
}

function classifyApplyFailure(result: unknown): Readonly<{
  classification: DaemonServerWorkErrorClassification | null;
  lastError: string;
  failureReason?: string;
  terminalReason?: string | null;
}> | null {
  const failure = readApplyFailureDiagnostics(result);
  if (!failure.errorCode) return null;

  if (
    failure.errorCode === 'post_switch_verification_failed'
    || failure.errorCode === 'provider_account_adoption_mismatch'
  ) {
    const embeddedClassification = asRecord(asRecord(failure.diagnostics?.verification)?.errorClassification)
      ?? asRecord(failure.diagnostics?.errorClassification);
    const classification = isServerWorkErrorClassification(embeddedClassification)
      ? embeddedClassification
      : failure.diagnostics?.retryable === true
        ? ({ kind: 'protocol_error', retryable: true } satisfies DaemonServerWorkErrorClassification)
        : ({ kind: 'protocol_error', retryable: false } satisfies DaemonServerWorkErrorClassification);
    return {
      classification,
      lastError: readVerificationReason(failure.diagnostics) ?? failure.errorCode,
    };
  }

  if (
    failure.errorCode === 'restart_failed'
    && failure.diagnostics?.failurePhase === 'restart'
    && failure.diagnostics.retryable === true
  ) {
    const embeddedClassification = asRecord(failure.diagnostics.errorClassification);
    return {
      classification: isServerWorkErrorClassification(embeddedClassification)
        ? embeddedClassification
        : ({ kind: 'protocol_error', retryable: true } satisfies DaemonServerWorkErrorClassification),
      lastError: 'restart_failed',
    };
  }

  // Incident Jun-11 H-A: a continuity resolution against a MISSING account-settings snapshot
  // (freshly restarted daemon, no spawn/settings hint yet) is an infrastructure gap, not a
  // provider verdict. It must wait-and-retry — the snapshot warms within seconds — never
  // terminalize as a non-retryable apply failure while state sharing is in fact enabled.
  if (failure.errorCode === 'provider_state_sharing_settings_unavailable') {
    return {
      classification: { kind: 'dependency_unavailable', retryable: true } satisfies DaemonServerWorkErrorClassification,
      lastError: failure.errorCode,
    };
  }

  if (failure.errorCode === 'provider_session_state_unavailable_for_resume') {
    const embeddedClassification = asRecord(failure.diagnostics?.errorClassification);
    const classification = isServerWorkErrorClassification(embeddedClassification)
      ? embeddedClassification
      : ({ kind: 'dependency_unavailable', retryable: true } satisfies DaemonServerWorkErrorClassification);
    if (
      failure.diagnostics?.retryable === false
      || classification.retryable === false
      || isDurableContinuityReconstructionExhausted(failure.diagnostics)
    ) {
      return {
        classification: classification.retryable
          ? ({ kind: 'protocol_error', retryable: false } satisfies DaemonServerWorkErrorClassification)
          : classification,
        lastError: failure.errorCode,
        terminalReason: 'provider_session_state_unavailable_after_reconstruction',
      };
    }
    return {
      classification,
      lastError: failure.errorCode,
      failureReason: 'durable_continuity_reconstruction_retrying',
    };
  }

  if (failure.errorCode !== 'hot_apply_failed') {
    return {
      classification: { kind: 'protocol_error', retryable: false } satisfies DaemonServerWorkErrorClassification,
      lastError: failure.errorCode,
    };
  }

  const embeddedClassification = failure.diagnostics?.underlyingErrorClassification;
  if (isServerWorkErrorClassification(embeddedClassification)) {
    return {
      classification: embeddedClassification,
      lastError: embeddedClassification.kind,
    };
  }

  const underlyingError = readString(failure.diagnostics?.underlyingError);
  if (!underlyingError) {
    return {
      classification: { kind: 'protocol_error', retryable: false } satisfies DaemonServerWorkErrorClassification,
      lastError: 'hot_apply_failed',
    };
  }
  const classification = classifyDaemonServerWorkError(new Error(underlyingError));
  return {
    classification,
    lastError: classification.kind,
  };
}

function classifyThrownApplyFailure(error: unknown): Readonly<{
  classification: DaemonServerWorkErrorClassification | null;
  lastError: string;
  failureReason: string;
  terminalReason?: string | null;
}> | null {
  const failure = readConnectedServiceAuthGenerationApplyFailure(error);
  if (!failure) return null;
  const result = {
    status: 'switch_attempted',
    result: {
      status: 'generation_apply_failed',
      errorCode: failure.errorCode,
      ...(failure.diagnostics === undefined ? {} : { diagnostics: failure.diagnostics }),
    },
  };
  const classified = classifyApplyFailure(result);
  return {
    classification: classified?.classification ?? ({ kind: 'protocol_error', retryable: false } satisfies DaemonServerWorkErrorClassification),
    lastError: classified?.lastError ?? failure.errorCode,
    failureReason: classified?.failureReason ?? failure.errorCode,
    terminalReason: classified?.terminalReason ?? null,
  };
}

function resolveInitialRetryAtMs(input: Readonly<{
  nowMs: number;
  baseBackoffMs: number;
  jitterMs: number;
  errorClassification: DaemonServerWorkErrorClassification;
}>): number {
  const retryAfterMs = typeof input.errorClassification.retryAfterMs === 'number'
    && Number.isFinite(input.errorClassification.retryAfterMs)
    ? Math.max(0, input.errorClassification.retryAfterMs)
    : 0;
  return input.nowMs + Math.max(input.baseBackoffMs + input.jitterMs, retryAfterMs);
}

function hasSameRuntimeAuthRecoveryKey(
  previous: RuntimeAuthRecoveryIntent,
  next: RuntimeAuthRecoveryIntent,
): boolean {
  if (previous.sessionId !== next.sessionId || previous.serviceId !== next.serviceId) return false;
  if (previous.groupId || next.groupId) return previous.groupId === next.groupId;
  return previous.profileId === next.profileId;
}

// Recovery-identity matching for proof-driven clears: a group-backed identity
// clears the group-keyed intent regardless of the reported profile (the group is
// the recovery subject); a profile-backed identity only clears a profile-keyed
// intent for the same profile.
function matchesRuntimeAuthRecoveryIdentity(
  intent: Pick<RuntimeAuthRecoveryIntent, 'serviceId' | 'groupId' | 'profileId' | 'status' | 'lastError' | 'classification' | 'pendingTargetGeneration' | 'pendingTargetProfileId' | 'pendingTargetCredentialRevision'>,
  identity: Readonly<{
    serviceId: string;
    groupId: string | null;
    profileId: string | null;
    groupGeneration?: number | null;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  }>,
): boolean {
  if (intent.serviceId !== identity.serviceId) return false;
  const pendingTargetProfileId = intent.pendingTargetProfileId ?? null;
  const pendingTargetGeneration = intent.pendingTargetGeneration ?? null;
  const pendingTargetCredentialRevision = intent.pendingTargetCredentialRevision ?? null;
  const hasPendingTarget = pendingTargetProfileId !== null
    || pendingTargetGeneration !== null
    || pendingTargetCredentialRevision !== null;
  // Once recovery selects a target, proof must describe that complete target tuple.
  // Older records missing any tuple member stay pending until it is reconstructed.
  if (hasPendingTarget && (
    pendingTargetProfileId === null
    || pendingTargetGeneration === null
    || pendingTargetCredentialRevision === null
  )) return false;
  const failedCredentialRevision = intent.classification.expectedCredentialRevision ?? null;
  const isRefreshWithoutSwitch = !hasPendingTarget
    && intent.status === 'resumed_awaiting_proof'
    && intent.lastError === RUNTIME_AUTH_RECOVERY_UNPROVEN_PROVIDER_OUTCOME_ERROR;
  if (isRefreshWithoutSwitch) {
    if (
      failedCredentialRevision === null
      || identity.credentialRevision === null
      || identity.credentialRevision === undefined
      || identity.credentialRevision === failedCredentialRevision
    ) return false;
    if (identity.profileId !== intent.profileId) return false;
  } else {
    const expectedCredentialRevision = hasPendingTarget
      ? pendingTargetCredentialRevision
      : failedCredentialRevision;
    if (expectedCredentialRevision !== null && identity.credentialRevision !== expectedCredentialRevision) return false;
  }
  const expectedGeneration = hasPendingTarget
    ? pendingTargetGeneration
    : intent.classification.groupGeneration ?? null;
  if (isRefreshWithoutSwitch) {
    if (
      expectedGeneration === null
      || typeof identity.groupGeneration !== 'number'
      || !Number.isInteger(identity.groupGeneration)
      || identity.groupGeneration < expectedGeneration
    ) return false;
  } else if (expectedGeneration !== null && identity.groupGeneration !== expectedGeneration) {
    return false;
  }
  const expectedProfileId = hasPendingTarget ? pendingTargetProfileId : null;
  if (expectedProfileId !== null && identity.profileId !== expectedProfileId) return false;
  if (identity.groupId) {
    return intent.groupId === identity.groupId;
  }
  return intent.groupId === null && intent.profileId === identity.profileId;
}

function isApplicableRuntimeAuthRecoveryProof(
  intent: RuntimeAuthRecoveryIntent,
  proof: RuntimeAuthRecoveryProofByIdentityInput,
): boolean {
  return matchesRuntimeAuthRecoveryIdentity(intent, proof)
    && typeof proof.observedAtMs === 'number'
    && Number.isFinite(proof.observedAtMs)
    && proof.observedAtMs >= intent.armedAtMs
    && (
      proof.proofKind !== 'quota_probe_fresh'
      || intent.classification.kind === 'usage_limit'
      || intent.classification.kind === 'rate_limit'
    );
}

function isPendingRuntimeAuthRecoveryStatus(status: RuntimeAuthRecoveryStatus): boolean {
  return status === 'waiting'
    || status === 'checking'
    || status === 'resumed_awaiting_proof';
}

function isWaitingRuntimeAuthRecoveryStatus(status: RuntimeAuthRecoveryStatus): boolean {
  return status === 'waiting' || status === 'resumed_awaiting_proof';
}

function resolveEarlierRetryAtMs(
  previous: number | null,
  next: number | null,
): number | null {
  if (previous === null) return next;
  if (next === null) return previous;
  return Math.min(previous, next);
}

function resolveStricterMaxAttempts(previous: number, next: number): number {
  if (previous <= 0) return next;
  if (next <= 0) return previous;
  return Math.min(previous, next);
}

function mergePendingVisibleEvents(
  previous: ReadonlyArray<RuntimeAuthRecoveryPendingVisibleEvent> | undefined,
  next: ReadonlyArray<RuntimeAuthRecoveryPendingVisibleEvent> | undefined,
): ReadonlyArray<RuntimeAuthRecoveryPendingVisibleEvent> | undefined {
  const merged = [...(previous ?? [])];
  for (const candidate of next ?? []) {
    if (merged.some((existing) => existing.attemptId === candidate.attemptId && existing.transition === candidate.transition)) continue;
    merged.push(candidate);
  }
  return merged.length > 0 ? merged : undefined;
}

function transitionRank(transition: RuntimeAuthRecoveryTransition | undefined): number {
  if (transition === 'working') return 0;
  if (transition === 'scheduled') return 1;
  if (transition === 'terminal' || transition === 'recovered') return 2;
  return -1;
}

function settleVisibleTransition(
  intent: RuntimeAuthRecoveryIntent,
  transition: Extract<RuntimeAuthRecoveryTransition, 'terminal' | 'recovered'>,
  reason: string,
): RuntimeAuthRecoveryIntent {
  if (!intent.attemptId || transitionRank(transition) <= transitionRank(intent.lastSettledTransition)) return intent;
  const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
    status: transition === 'recovered' ? 'recovered' : 'cancelled',
    classification: intent.classification,
    attempt: intent.attemptCount,
    terminal: true,
    reason,
  });
  return {
    ...intent,
    lastSettledTransition: transition,
    ...(transcriptEvent ? {
      pendingVisibleEvents: mergePendingVisibleEvents(intent.pendingVisibleEvents, [{
        attemptId: intent.attemptId,
        transition,
        transcriptEvent,
      }]),
    } : {}),
  };
}

function mergeRuntimeAuthRecoveryIntent(
  previous: RuntimeAuthRecoveryIntent | null,
  next: RuntimeAuthRecoveryIntent,
): RuntimeAuthRecoveryIntent {
  if (!previous || !hasSameRuntimeAuthRecoveryKey(previous, next)) return next;
  if (previous.status === 'recovered') return next;
  if (previous.status === 'cancelled' || previous.status === 'exhausted') {
    if (previous.attemptId === next.attemptId) return previous;
    // Only a fresh in-band provider report owns a new recovery epoch. A later handler/apply
    // failure without the original attempt id is still fallout from the settled attempt and must
    // not revive it merely because its caller omitted the report id.
    return next.lastSettledTransition === 'working' ? next : previous;
  }
  if (previous.status === 'checking') {
    return previous;
  }
  return {
    ...next,
    attemptId: previous.attemptId ?? next.attemptId,
    lastSettledTransition: previous.lastSettledTransition ?? next.lastSettledTransition,
    ...(mergePendingVisibleEvents(previous.pendingVisibleEvents, next.pendingVisibleEvents) === undefined
      ? {}
      : { pendingVisibleEvents: mergePendingVisibleEvents(previous.pendingVisibleEvents, next.pendingVisibleEvents) }),
    resumePromptMode: previous.resumePromptMode,
    status: previous.status,
    armedAtMs: previous.armedAtMs,
    attemptCount: previous.attemptCount,
    maxAttempts: resolveStricterMaxAttempts(previous.maxAttempts, next.maxAttempts),
    nextRetryAtMs: resolveEarlierRetryAtMs(previous.nextRetryAtMs, next.nextRetryAtMs),
    pendingTargetProfileId: next.pendingTargetProfileId ?? null,
    pendingTargetGeneration: next.pendingTargetGeneration ?? null,
    pendingTargetCredentialRevision: next.pendingTargetCredentialRevision ?? null,
    terminalAtMs: next.terminalAtMs ?? null,
    terminalReason: next.terminalReason ?? null,
  };
}

type RuntimeAuthPendingProofTarget = Readonly<{
  activeProfileId: string | null;
  generation: number | null;
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
}>;

function readPendingProofTarget(result: unknown): RuntimeAuthPendingProofTarget | null {
  const switchResult = readRuntimeAuthRecoverySwitchResult(result);
  if (!switchResult) return null;
  const status = readString(switchResult.status);
  if (status !== 'switched' && status !== 'observed_generation') return null;
  return {
    activeProfileId: readString(switchResult.activeProfileId),
    generation: readNonNegativeNumber(switchResult.generation),
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema.safeParse(switchResult.credentialRevision).data ?? null,
  };
}

function isStaleProfileReplayForPendingProofTarget(input: Readonly<{
  intent: RuntimeAuthRecoveryIntent;
  pendingTarget: RuntimeAuthPendingProofTarget | null;
}>): boolean {
  // The pending proof target is matched by PROFILE, deliberately NOT by group generation:
  // sibling sessions thrash the shared group generation between replays (incident
  // 2026-06-12, gen 81→87), so an exact-generation match never holds and the attempt
  // rollback is defeated — replays burn the dead-letter budget while the session is
  // legitimately waiting for proof of the SAME target profile. The rollback stays
  // bounded by the coalesced-replay budget.
  const currentTargetProfileId = input.pendingTarget?.activeProfileId ?? null;
  if (!currentTargetProfileId) return false;
  if (input.intent.pendingTargetProfileId !== currentTargetProfileId) return false;
  const failingProfileId = input.intent.classification.profileId;
  return Boolean(failingProfileId && failingProfileId !== currentTargetProfileId);
}

type SupersededPendingProofIntent = Readonly<{
  key: string;
  intent: RuntimeAuthRecoveryIntent;
}>;

export class RuntimeAuthRecoveryScheduler implements RuntimeAuthRecoverySchedulerLike {
  readonly #nowMs: () => number;
  readonly #baseBackoffMs: number;
  readonly #maxAttempts: number;
  readonly #maxCoalescedReplays: number;
  readonly #maxDegradedAttempts: number;
  readonly #degradedBackoffMs: number;
  readonly #providerOutcomePendingWaitMs: number | null;
  readonly #jitterMs: () => number;
  readonly #scheduler: DurableBackoffRecoveryScheduler<RuntimeAuthRecoveryIntent>;
  readonly #recordDiagnostic: ((event: RuntimeAuthRecoveryDiagnostic) => void) | null;
  readonly #recoveryKeysBySessionId = new Map<string, Set<string>>();
  #pendingVisibleEventDrainTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingVisibleEventDrainInFlight = false;
  #pendingVisibleEventDrainRequested = false;
  #pendingVisibleEventDrainDisposed = false;
  #pendingVisibleEventDeliver: ((delivery: RuntimeAuthRecoveryVisibleEventDelivery) => Promise<void>) | null = null;
  #pendingVisibleEventRetryDelayMs = 2_000;
  #pendingVisibleEventDrainError: ((error: unknown) => void) | null = null;

  constructor(deps: Readonly<{
    nowMs: () => number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    jitterMs?: () => number;
    maxAttempts?: number;
    maxCoalescedReplays?: number;
    providerOutcomePendingWaitMs?: number;
    maxDegradedAttempts?: number;
    degradedBackoffMs?: number;
    recover: (input: Readonly<{
      sessionId: string;
      switchesThisTurn: number;
      classification: ConnectedServiceRuntimeFailureClassification;
      resumePromptMode: 'standard' | 'off' | 'custom';
      recoveryInvocationSource: 'scheduler_retry';
    }>) => Promise<unknown>;
    gate?: (input: { sessionId: string; intent: RuntimeAuthRecoveryIntent }) =>
      | Readonly<{ status: 'open' }>
      | Readonly<{ status: 'delayed'; retryAtMs: number; reason: string }>;
    recordDiagnostic?: (event: RuntimeAuthRecoveryDiagnostic) => void;
    durableStore?: DurableBackoffRecoveryStore<RuntimeAuthRecoveryIntent>;
  }>) {
    this.#nowMs = deps.nowMs;
    this.#baseBackoffMs = clampPositiveInteger(deps.baseBackoffMs, DEFAULT_RUNTIME_AUTH_RECOVERY_BASE_BACKOFF_MS);
    const maxBackoffMs = clampPositiveInteger(deps.maxBackoffMs, DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_BACKOFF_MS);
    this.#maxAttempts = clampPositiveInteger(deps.maxAttempts, DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS);
    this.#maxCoalescedReplays = typeof deps.maxCoalescedReplays === 'number'
      && Number.isFinite(deps.maxCoalescedReplays)
      && deps.maxCoalescedReplays >= 0
      ? Math.trunc(deps.maxCoalescedReplays)
      : DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_COALESCED_REPLAYS;
    this.#maxDegradedAttempts = clampPositiveInteger(deps.maxDegradedAttempts, DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_DEGRADED_ATTEMPTS);
    this.#degradedBackoffMs = clampPositiveInteger(deps.degradedBackoffMs, DEFAULT_RUNTIME_AUTH_RECOVERY_DEGRADED_BACKOFF_MS);
    this.#providerOutcomePendingWaitMs = typeof deps.providerOutcomePendingWaitMs === 'number'
      && Number.isFinite(deps.providerOutcomePendingWaitMs)
      && deps.providerOutcomePendingWaitMs > 0
      ? Math.trunc(deps.providerOutcomePendingWaitMs)
      : null;
    this.#jitterMs = deps.jitterMs ?? (() => 0);
    this.#recordDiagnostic = deps.recordDiagnostic ?? null;
    this.#scheduler = new DurableBackoffRecoveryScheduler<RuntimeAuthRecoveryIntent>({
      nowMs: deps.nowMs,
      baseBackoffMs: this.#baseBackoffMs,
      maxBackoffMs,
      jitterMs: this.#jitterMs,
      store: deps.durableStore,
      normalizeIntent: normalizeRuntimeAuthRecoveryIntent,
      getStatus: (intent) => intent.status === 'resumed_awaiting_proof'
        ? 'waiting'
        : intent.status === 'recovered'
          ? 'cancelled'
          : intent.status,
      getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      terminalRecordRetentionMs: DEFAULT_RUNTIME_AUTH_RECOVERY_TERMINAL_RECORD_RETENTION_MS,
      getTerminalPruneReferenceMs: (intent) => intent.terminalAtMs ?? intent.armedAtMs,
      markChecking: (intent, attemptCount) => ({
        ...intent,
        status: 'checking',
        attemptCount,
      }),
      markWaiting: (intent, next) => ({
        ...intent,
        status: intent.status === 'resumed_awaiting_proof' ? 'resumed_awaiting_proof' : 'waiting',
        nextRetryAtMs: next.nextRetryAtMs,
        lastError: next.lastError,
      }),
      markCancelled: (intent) => ({
        ...settleVisibleTransition(intent, intent.lastSettledTransition === 'recovered' ? 'recovered' : 'terminal', intent.terminalReason ?? 'runtime_auth_recovery_cancelled'),
        status: intent.lastSettledTransition === 'recovered' ? 'recovered' : 'cancelled',
        nextRetryAtMs: null,
        terminalAtMs: deps.nowMs(),
      }),
      markExhausted: (intent, next) => ({
        ...settleVisibleTransition(intent, 'terminal', next.lastError ?? 'max_attempts_exhausted'),
        status: 'exhausted',
        nextRetryAtMs: null,
        lastError: next.lastError,
        terminalAtMs: deps.nowMs(),
        terminalReason: next.lastError,
      }),
      recover: async (intent, context) => {
        void context;
        this.#emit({
          event: 'runtime_auth_recovery_retry',
          sessionId: intent.sessionId,
          serviceId: intent.classification.serviceId,
          groupId: intent.classification.groupId,
          profileId: intent.classification.profileId,
          failurePhase: intent.failurePhase,
          attemptCount: intent.attemptCount,
          errorClassification: intent.lastErrorClassification,
          failureKind: intent.classification.kind,
        });
        try {
          const result = await deps.recover({
            sessionId: intent.sessionId,
            switchesThisTurn: intent.switchesThisTurn,
            classification: intent.classification,
            resumePromptMode: intent.resumePromptMode === 'off' || intent.resumePromptMode === 'custom'
              ? intent.resumePromptMode
              : 'standard',
            recoveryInvocationSource: 'scheduler_retry',
          });
          if (isSuccessfulRecoveryResult(result)) {
            return {
              status: 'success' as const,
              intent: settleVisibleTransition(intent, 'recovered', 'provider_outcome_proven'),
            };
          }
          const supersededReason = readRuntimeAuthRecoverySupersededReason(result);
          if (supersededReason) {
            return { status: 'superseded' as const, reason: supersededReason };
          }
          const temporaryRetryStatus = readTemporaryRetryWakeStatus(result);
          if (temporaryRetryStatus) {
            return { status: 'superseded' as const, reason: temporaryRetryStatus };
          }
          const disposition = resolveRuntimeAuthRecoveryDisposition({
            result,
            intent,
            nowMs: this.#nowMs(),
          });
          if (disposition?.kind === 'durable_wait') {
            return {
              status: 'wait' as const,
              nextRetryAtMs: disposition.nextRetryAtMs,
              lastError: disposition.reason,
              intent: {
                ...intent,
                status: 'waiting',
                attemptCount: Math.max(0, intent.attemptCount - 1),
                nextRetryAtMs: disposition.nextRetryAtMs,
                lastError: disposition.reason,
                terminalReason: null,
              },
            };
          }
          if (isLocallyCompleteWithoutProof(result)) {
            const pendingTarget = readPendingProofTarget(result);
            const coalescedReplay = isStaleProfileReplayForPendingProofTarget({
              intent,
              pendingTarget,
            });
            // Each coalesced replay re-runs the full switch pipeline, so the attempt
            // rollback must be budgeted: once `maxCoalescedReplays` is spent, replays
            // consume the normal attempt budget and the recovery settles terminal
            // instead of looping forever for an idle session.
            const coalescedReplayCount = intent.coalescedReplayCount ?? 0;
            const rollbackAttempt = isUntargetedProviderOutcomeProofWaitRefresh({
              intent,
              pendingTarget,
            }) || (coalescedReplay && coalescedReplayCount < this.#maxCoalescedReplays);
            return {
              status: 'wait' as const,
              lastError: RUNTIME_AUTH_RECOVERY_UNPROVEN_PROVIDER_OUTCOME_ERROR,
              intent: {
                ...intent,
                status: 'resumed_awaiting_proof',
                attemptCount: rollbackAttempt ? Math.max(0, intent.attemptCount - 1) : intent.attemptCount,
                lastError: RUNTIME_AUTH_RECOVERY_UNPROVEN_PROVIDER_OUTCOME_ERROR,
                ...(coalescedReplay ? { coalescedReplayCount: coalescedReplayCount + 1 } : {}),
                ...(pendingTarget
                  ? {
                      pendingTargetProfileId: pendingTarget.activeProfileId,
                      pendingTargetGeneration: pendingTarget.generation,
                      pendingTargetCredentialRevision: pendingTarget.credentialRevision,
                    }
                  : {
                      pendingTargetProfileId: intent.pendingTargetProfileId ?? null,
                      pendingTargetGeneration: intent.pendingTargetGeneration ?? null,
                      pendingTargetCredentialRevision: intent.pendingTargetCredentialRevision ?? null,
                    }),
              },
              ...(this.#providerOutcomePendingWaitMs === null
                ? {}
                : { nextRetryAtMs: this.#nowMs() + this.#providerOutcomePendingWaitMs }),
            };
          }
          if (disposition?.kind === 'terminal') {
            return {
              status: 'terminal' as const,
              lastError: disposition.reason,
              intent: {
                ...intent,
                lastError: disposition.reason,
                terminalReason: disposition.reason,
              },
            };
          }
          if (isTerminalRecoveryResult(result)) {
            const terminalReason = resolveTerminalRecoveryReason(result) ?? 'terminal_recovery_result';
            return {
              status: 'terminal' as const,
              lastError: terminalReason,
              intent: {
                ...intent,
                lastError: terminalReason,
                terminalReason,
              },
            };
          }
          // S2: a degraded daemon-lifecycle / endpoint-unavailable outcome is non-terminal — keep
          // the recovery waiting so a healthy daemon/endpoint re-drives it. Route it onto the
          // bounded degraded-retry track so a long local outage does not burn the normal attempt
          // budget (and so it never waits forever).
          if (isDegradedLifecycleRecoveryResult(result)) {
            return buildDegradedRecoveryOutcome({
              intent,
              reason: resolveDegradedReason(result),
              nowMs: this.#nowMs(),
              maxDegradedAttempts: this.#maxDegradedAttempts,
              degradedBackoffMs: this.#degradedBackoffMs,
            });
          }
          const applyFailure = classifyApplyFailure(result);
          if (applyFailure?.classification) {
            if (!applyFailure.classification.retryable) {
              const terminalReason = applyFailure.terminalReason ?? applyFailure.lastError;
              return {
                status: 'terminal' as const,
                lastError: terminalReason,
                intent: {
                  ...intent,
                  lastError: applyFailure.lastError,
                  terminalReason,
                },
              };
            }
            return {
              status: 'wait' as const,
              lastError: applyFailure.lastError,
              intent: {
                ...intent,
                failurePhase: 'apply',
                failureReason: readApplyFailureDiagnostics(result).errorCode ?? intent.failureReason,
                lastErrorClassification: applyFailure.classification,
              },
            };
          }
          return { status: 'terminal' as const, lastError: 'non_retryable_recovery_result' };
        } catch (error) {
          const thrownApplyFailure = classifyThrownApplyFailure(error);
          if (thrownApplyFailure) {
            if (!thrownApplyFailure.classification?.retryable) {
              return { status: 'terminal' as const, lastError: thrownApplyFailure.lastError };
            }
            return {
              status: 'wait' as const,
              lastError: thrownApplyFailure.lastError,
              intent: {
                ...intent,
                failurePhase: 'apply',
                failureReason: thrownApplyFailure.failureReason,
                lastError: thrownApplyFailure.lastError,
                lastErrorClassification: thrownApplyFailure.classification,
              },
            };
          }
          const errorClassification = classifyDaemonServerWorkError(error);
          if (!errorClassification.retryable) {
            return { status: 'terminal' as const, lastError: errorClassification.kind };
          }
          // S2: a connection-level endpoint outage thrown during the recovery fetch
          // (ECONNREFUSED / socket hang up / reset = `network`) is a degraded local condition, not a
          // provider failure. Route it onto the bounded degraded-retry track so a long local outage
          // cannot dead-letter the session before the normal attempt budget. A `timeout` is left on
          // the normal track: a slow-but-reachable endpoint can be a genuine recoverable failure.
          if (errorClassification.kind === 'network') {
            return buildDegradedRecoveryOutcome({
              intent: {
                ...intent,
                lastError: readErrorMessage(error) ?? errorClassification.kind,
                lastErrorClassification: errorClassification,
              },
              reason: 'session_endpoint_unavailable',
              nowMs: this.#nowMs(),
              maxDegradedAttempts: this.#maxDegradedAttempts,
              degradedBackoffMs: this.#degradedBackoffMs,
            });
          }
          return {
            status: 'wait' as const,
            lastError: readErrorMessage(error) ?? errorClassification.kind,
            intent: {
              ...intent,
              lastErrorClassification: errorClassification,
            },
          };
        }
      },
      gate: deps.gate
        ? ({ intent }) => deps.gate!({ sessionId: intent.sessionId, intent })
        : undefined,
      clearOnSuccess: false,
      onSuccess: async ({ intent }) => {
        if (!intent.attemptId) {
          await this.#scheduler.clear({ sessionId: this.#keyForIntent(intent) });
          this.#recoveryKeysBySessionId.get(intent.sessionId)?.delete(this.#keyForIntent(intent));
        }
        const recoveredEvent = intent.pendingVisibleEvents?.find((candidate) => candidate.transition === 'recovered');
        this.#emit({
          event: 'runtime_auth_recovery_success',
          sessionId: intent.sessionId,
          serviceId: intent.classification.serviceId,
          groupId: intent.classification.groupId,
          profileId: intent.classification.profileId,
          failurePhase: intent.failurePhase,
          attemptCount: intent.attemptCount,
          failureKind: intent.classification.kind,
          ...(recoveredEvent ? { transcriptEvent: recoveredEvent.transcriptEvent } : {}),
        });
      },
      onSuperseded: ({ intent, reason }) => {
        this.#recoveryKeysBySessionId.get(intent.sessionId)?.delete(this.#keyForIntent(intent));
        this.#emit({
          event: 'runtime_auth_recovery_superseded',
          sessionId: intent.sessionId,
          serviceId: intent.classification.serviceId,
          groupId: intent.classification.groupId,
          profileId: intent.classification.profileId,
          failurePhase: intent.failurePhase,
          attemptCount: intent.attemptCount,
          reason: reason ?? 'recovery_superseded',
        });
      },
      onDelayed: ({ intent, retryAtMs, reason }) => this.#emit({
        event: 'runtime_auth_recovery_delayed',
        sessionId: intent.sessionId,
        serviceId: intent.classification.serviceId,
        groupId: intent.classification.groupId,
        profileId: intent.classification.profileId,
        failurePhase: intent.failurePhase,
        attemptCount: intent.attemptCount,
        nextRetryAtMs: retryAtMs,
        reason,
        errorClassification: intent.lastErrorClassification,
      }),
      onExhausted: ({ intent, lastError }) => {
        const reason = lastError ?? 'max_attempts_exhausted';
        const uxDiagnostic = buildConnectedServiceUxDiagnostic({
          code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryDeadLettered,
          failurePhase: 'runtime_auth_recovery',
          source: 'runtime_auth_recovery',
          serviceId: intent.classification.serviceId,
          profileId: intent.classification.profileId,
          groupId: intent.classification.groupId,
          retryable: true,
          diagnostics: {
            reason,
            attemptCount: intent.attemptCount,
          },
        });
        const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
          status: 'dead_lettered',
          classification: intent.classification,
          uxDiagnostic,
          attempt: intent.attemptCount,
          terminal: true,
          reason,
        });
        this.#emit({
          event: 'runtime_auth_recovery_dead_letter',
          sessionId: intent.sessionId,
          serviceId: intent.classification.serviceId,
          groupId: intent.classification.groupId,
          profileId: intent.classification.profileId,
          failurePhase: intent.failurePhase,
          attemptCount: intent.attemptCount,
          reason,
          errorClassification: intent.lastErrorClassification,
          failureKind: intent.classification.kind,
          uxDiagnostic,
          ...(transcriptEvent ? { transcriptEvent } : {}),
        });
      },
  });
  }

  async beginClassifiedFailure(input: Readonly<{
    reportId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>): Promise<RuntimeAuthRecoveryScheduleResult> {
    const retryAfterMs = resolveClassifiedFailureRetryAfterMs({
      classification: input.classification,
      nowMs: this.#nowMs(),
    });
    return await this.#enqueue({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      failurePhase: 'handler',
      failureReason: 'classified_failure_reported',
      lastError: input.classification.kind,
      errorClassification: {
        kind: mapRuntimeFailureKindToDaemonWorkErrorKind(input.classification.kind),
        retryable: true,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
      terminalReason: null,
      resumePromptMode: input.resumePromptMode,
      reportId: input.reportId,
      transition: 'working',
      projectVisibleEvent: false,
    });
  }

  async enqueueHandlerFailure(input: Readonly<{
    reportId?: string;
    expectedAttemptId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    error: unknown;
  }>): Promise<RuntimeAuthRecoveryScheduleResult> {
    const thrownApplyFailure = classifyThrownApplyFailure(input.error);
    if (thrownApplyFailure) {
      return await this.#enqueue({
        sessionId: input.sessionId,
        switchesThisTurn: input.switchesThisTurn,
        classification: input.classification,
        failurePhase: 'apply',
        failureReason: thrownApplyFailure.failureReason,
        lastError: thrownApplyFailure.lastError,
        errorClassification: thrownApplyFailure.classification,
        terminalReason: thrownApplyFailure.classification?.retryable === true
          ? null
          : thrownApplyFailure.terminalReason ?? 'non_retryable_apply_failure',
        reportId: input.reportId,
        expectedAttemptId: input.expectedAttemptId,
        transition: 'scheduled',
        projectVisibleEvent: true,
      });
    }
    const errorClassification = classifyDaemonServerWorkError(input.error);
    return await this.#enqueue({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      failurePhase: 'handler',
      lastError: readErrorMessage(input.error) ?? errorClassification.kind,
      errorClassification,
      terminalReason: isTerminalRuntimeFailureClassification(input.classification) || !errorClassification.retryable
        ? 'non_retryable_handler_failure'
        : null,
      reportId: input.reportId,
      expectedAttemptId: input.expectedAttemptId,
      transition: 'scheduled',
      projectVisibleEvent: true,
    });
  }

  async enqueueApplyFailure(input: Readonly<{
    reportId?: string;
    expectedAttemptId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    result: unknown;
  }>): Promise<RuntimeAuthRecoveryScheduleResult> {
    const applyFailure = classifyApplyFailure(input.result);
    return await this.#enqueue({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      failurePhase: 'apply',
      failureReason: applyFailure?.failureReason
        ?? readApplyFailureDiagnostics(input.result).errorCode
        ?? 'non_retryable_apply_failure',
      lastError: applyFailure?.lastError ?? 'non_retryable_apply_failure',
      errorClassification: applyFailure?.classification ?? null,
      terminalReason: applyFailure?.classification?.retryable === true
        ? null
        : applyFailure?.terminalReason ?? 'non_retryable_apply_failure',
      reportId: input.reportId,
      expectedAttemptId: input.expectedAttemptId,
      transition: 'scheduled',
      projectVisibleEvent: true,
    });
  }

  #buildKey(input: RuntimeAuthRecoveryKeyParts): string {
    return buildRuntimeAuthRecoveryKey(input);
  }

  #keyForIntent(intent: RuntimeAuthRecoveryIntent): string {
    return this.#buildKey({
      sessionId: intent.sessionId,
      serviceId: intent.serviceId,
      profileId: intent.profileId,
      groupId: intent.groupId,
      failingAccessTokenFingerprint: intent.classification.failingAccessTokenFingerprint ?? null,
    });
  }

  #rememberIntent(intent: RuntimeAuthRecoveryIntent): void {
    const key = this.#keyForIntent(intent);
    const keys = this.#recoveryKeysBySessionId.get(intent.sessionId) ?? new Set<string>();
    keys.add(key);
    this.#recoveryKeysBySessionId.set(intent.sessionId, keys);
  }

  #readForSession(
    sessionId: string,
    options: Readonly<{ schedule?: boolean }> = {},
  ): ReadonlyArray<RuntimeAuthRecoveryIntent> {
    const knownKeys = this.#recoveryKeysBySessionId.get(sessionId) ?? new Set<string>();
    const intents: RuntimeAuthRecoveryIntent[] = [];
    for (const key of knownKeys) {
      const intent = this.#scheduler.read(key, options);
      if (!intent || intent.sessionId !== sessionId) continue;
      intents.push(intent);
    }
    if (intents.length > 0) return intents;

    const legacyIntent = this.#scheduler.read(sessionId, options);
    return legacyIntent ? [legacyIntent] : [];
  }

  /**
   * Stop all armed recovery timers during daemon shutdown. Durable waiting and presentation
   * custody remain stored; dispose never fires recovery work during teardown.
   */
  dispose(): void {
    this.#pendingVisibleEventDrainDisposed = true;
    if (this.#pendingVisibleEventDrainTimer) clearTimeout(this.#pendingVisibleEventDrainTimer);
    this.#pendingVisibleEventDrainTimer = null;
    this.#scheduler.dispose();
  }

  hydratePassive(): ReadonlyArray<RuntimeAuthRecoveryIntent> {
    const intents = this.#scheduler.hydrate({ schedule: false });
    for (const intent of intents) this.#rememberIntent(intent);
    return intents;
  }

  async drainPendingVisibleEvents(
    deliver: (delivery: RuntimeAuthRecoveryVisibleEventDelivery) => Promise<void>,
  ): Promise<number> {
    let delivered = 0;
    const intents = Array.from(this.#recoveryKeysBySessionId.keys())
      .flatMap((sessionId) => this.#readForSession(sessionId, { schedule: false }));
    for (const intent of intents) {
      const recoveryKey = this.#keyForIntent(intent);
      for (const pending of intent.pendingVisibleEvents ?? []) {
        await deliver({ sessionId: intent.sessionId, ...pending });
        await this.#acknowledgePendingVisibleEvent(recoveryKey, pending);
        delivered += 1;
      }
    }
    return delivered;
  }

  schedulePendingVisibleEventDrain(input: Readonly<{
    deliver: (delivery: RuntimeAuthRecoveryVisibleEventDelivery) => Promise<void>;
    delayMs?: number;
    retryDelayMs?: number;
    onError?: (error: unknown) => void;
  }>): void {
    if (this.#pendingVisibleEventDrainDisposed) return;
    this.#pendingVisibleEventDeliver = input.deliver;
    this.#pendingVisibleEventRetryDelayMs = typeof input.retryDelayMs === 'number' && Number.isFinite(input.retryDelayMs)
      ? Math.min(60_000, Math.max(0, Math.trunc(input.retryDelayMs)))
      : this.#pendingVisibleEventRetryDelayMs;
    this.#pendingVisibleEventDrainError = input.onError ?? this.#pendingVisibleEventDrainError;
    this.#pendingVisibleEventDrainRequested = true;
    if (this.#pendingVisibleEventDrainTimer || this.#pendingVisibleEventDrainInFlight) return;
    const delayMs = typeof input.delayMs === 'number' && Number.isFinite(input.delayMs)
      ? Math.max(0, Math.trunc(input.delayMs))
      : 2_000;
    this.#pendingVisibleEventDrainTimer = setTimeout(() => {
      this.#pendingVisibleEventDrainTimer = null;
      void this.#runPendingVisibleEventDrain();
    }, delayMs);
    this.#pendingVisibleEventDrainTimer.unref?.();
  }

  async #runPendingVisibleEventDrain(): Promise<void> {
    const deliver = this.#pendingVisibleEventDeliver;
    if (!deliver || this.#pendingVisibleEventDrainInFlight) return;
    this.#pendingVisibleEventDrainInFlight = true;
    this.#pendingVisibleEventDrainRequested = false;
    try {
      await this.drainPendingVisibleEvents(deliver);
    } catch (error) {
      if (!this.#pendingVisibleEventDrainDisposed) this.#pendingVisibleEventDrainRequested = true;
      this.#pendingVisibleEventDrainError?.(error);
    } finally {
      this.#pendingVisibleEventDrainInFlight = false;
    }
    if (!this.#pendingVisibleEventDrainDisposed && this.#pendingVisibleEventDrainRequested) {
      this.schedulePendingVisibleEventDrain({ deliver, delayMs: this.#pendingVisibleEventRetryDelayMs });
    }
  }

  async #acknowledgePendingVisibleEvent(
    recoveryKey: string,
    pending: RuntimeAuthRecoveryPendingVisibleEvent,
  ): Promise<void> {
    await this.#scheduler.transact({
      sessionId: recoveryKey,
      schedule: false,
      transaction: (current) => {
        const intent = normalizeRuntimeAuthRecoveryIntent(current);
        if (!intent) return { intent: null, result: undefined };
        const remaining = intent.pendingVisibleEvents?.filter((candidate) => (
          candidate.attemptId !== pending.attemptId || candidate.transition !== pending.transition
        ));
        const { pendingVisibleEvents: _pending, ...rest } = intent;
        return {
          intent: {
            ...rest,
            ...(remaining && remaining.length > 0 ? { pendingVisibleEvents: remaining } : {}),
          },
          result: undefined,
        };
      },
    });
  }

  read(sessionId: string): RuntimeAuthRecoveryIntent | null {
    const intents = this.#readForSession(sessionId);
    return intents.find((intent) => isPendingRuntimeAuthRecoveryStatus(intent.status))
      ?? intents[0]
      ?? null;
  }

  readForSession(sessionId: string): ReadonlyArray<RuntimeAuthRecoveryIntent> {
    return this.#readForSession(sessionId);
  }

  async wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'manual' }>): Promise<Readonly<{ status: string }>> {
    const intents = this.#readForSession(input.sessionId);
    const intent = intents.find((candidate) => isPendingRuntimeAuthRecoveryStatus(candidate.status))
      ?? intents[0]
      ?? null;
    const result = await this.#scheduler.wake({
      sessionId: intent ? this.#keyForIntent(intent) : input.sessionId,
      reason: input.reason,
    });
    if (result.status === 'terminal') {
      const terminal = this.#readForSession(input.sessionId)[0] ?? null;
      this.#emit({
        event: 'runtime_auth_recovery_terminal',
        sessionId: input.sessionId,
        serviceId: terminal?.serviceId,
        groupId: terminal?.groupId,
        profileId: terminal?.profileId,
        failurePhase: terminal?.failurePhase,
        reason: terminal?.terminalReason ?? 'terminal_recovery_result',
        errorClassification: terminal?.lastErrorClassification ?? null,
      });
    }
    return result;
  }

  async cancel(input: Readonly<{ sessionId: string }>): Promise<RuntimeAuthRecoveryIntent | null> {
    const intents = this.#readForSession(input.sessionId);
    let firstCancelled: RuntimeAuthRecoveryIntent | null = null;
    for (const intent of intents) {
      const cancelled = await this.#scheduler.cancel({ sessionId: this.#keyForIntent(intent) });
      firstCancelled ??= cancelled;
    }
    if (firstCancelled) return firstCancelled;
    return await this.#scheduler.cancel(input);
  }

  async cancelExact(input: Readonly<{ sessionId: string; attemptId: string }>): Promise<ReadonlyArray<RuntimeAuthRecoveryIntent>> {
    const matches = this.#readForSession(input.sessionId).filter((intent) => intent.attemptId === input.attemptId);
    const cancelled: RuntimeAuthRecoveryIntent[] = [];
    for (const intent of matches) {
      const result = await this.#scheduler.transact<RuntimeAuthRecoveryIntent | null>({
        sessionId: this.#keyForIntent(intent),
        transaction: (currentValue) => {
          const current = normalizeRuntimeAuthRecoveryIntent(currentValue);
          if (
            !current
            || current.attemptId !== input.attemptId
          ) return { intent: current, result: null };
          const terminalReason = 'usage_limit_recovery_cancelled';
          const terminal = settleVisibleTransition({
            ...current,
            status: 'cancelled',
            nextRetryAtMs: null,
            terminalAtMs: this.#nowMs(),
            terminalReason,
          }, 'terminal', terminalReason);
          return { intent: terminal, result: terminal };
        },
      });
      if (result) cancelled.push(result);
    }
    return cancelled;
  }

  async cancelByKey(input: RuntimeAuthRecoveryKeyParts): Promise<RuntimeAuthRecoveryIntent | null> {
    return await this.#scheduler.cancel({ sessionId: this.#buildKey(input) });
  }

  async rearmAfterConfirmedEffectOwnerLossByKey(
    input: RuntimeAuthRecoveryKeyParts & Readonly<{
      authorization: 'fresh_user_action_after_owner_loss';
    }>,
  ): Promise<RuntimeAuthRecoveryIntent | null> {
    return await this.#scheduler.rearmAfterConfirmedEffectOwnerLoss({
      sessionId: this.#buildKey(input),
      authorization: input.authorization,
    });
  }

  async markSucceededByKey(
    input: RuntimeAuthRecoveryKeyParts & Readonly<{ expectedAttemptId?: string }>,
  ): Promise<RuntimeAuthRecoveryIntent | null> {
    const key = this.#buildKey(input);
    const cleared = await this.#scheduler.transact<RuntimeAuthRecoveryIntent | null>({
      sessionId: key,
      transaction: (currentValue) => {
        const current = normalizeRuntimeAuthRecoveryIntent(currentValue);
        if (
          !current
          || !isPendingRuntimeAuthRecoveryStatus(current.status)
          || (input.expectedAttemptId && current.attemptId !== input.expectedAttemptId)
        ) {
          return { intent: current, result: null };
        }
        if (!current.attemptId) return { intent: null, result: current };
        const recovered = settleVisibleTransition({
          ...current,
          status: 'recovered',
          nextRetryAtMs: null,
          terminalAtMs: this.#nowMs(),
          terminalReason: 'provider_outcome_proven',
        }, 'recovered', 'provider_outcome_proven');
        return { intent: recovered, result: recovered };
      },
    });
    if (!cleared) return null;
    this.#emit({
      event: 'runtime_auth_recovery_success',
      sessionId: cleared.sessionId,
      serviceId: cleared.serviceId,
      groupId: cleared.groupId,
      profileId: cleared.profileId,
      failurePhase: cleared.failurePhase,
      attemptCount: cleared.attemptCount,
    });
    return cleared;
  }

  async markAwaitingProviderOutcomeProofByKey(
    input: RuntimeAuthRecoveryKeyParts & Readonly<{ expectedAttemptId?: string; result?: unknown }>,
  ): Promise<RuntimeAuthRecoveryIntent | null> {
    const key = this.#buildKey(input);
    const pendingTarget = readPendingProofTarget(input.result);
    const awaiting = await this.#scheduler.transact<RuntimeAuthRecoveryIntent | null>({
      sessionId: key,
      transaction: (currentValue) => {
        const current = normalizeRuntimeAuthRecoveryIntent(currentValue);
        if (
          !current
          || !isPendingRuntimeAuthRecoveryStatus(current.status)
          || (input.expectedAttemptId && current.attemptId !== input.expectedAttemptId)
        ) {
          return { intent: current, result: null };
        }
        const next: RuntimeAuthRecoveryIntent = {
          ...current,
          status: 'resumed_awaiting_proof',
          lastError: 'recovery_unproven_awaiting_provider_outcome',
          ...(pendingTarget
            ? {
                pendingTargetProfileId: pendingTarget.activeProfileId,
                pendingTargetGeneration: pendingTarget.generation,
                pendingTargetCredentialRevision: pendingTarget.credentialRevision,
              }
            : {
                pendingTargetProfileId: current.pendingTargetProfileId ?? input.profileId ?? null,
                pendingTargetGeneration: current.pendingTargetGeneration ?? null,
                pendingTargetCredentialRevision: current.pendingTargetCredentialRevision ?? null,
              }),
          ...(this.#providerOutcomePendingWaitMs === null
            ? {}
            : { nextRetryAtMs: this.#nowMs() + this.#providerOutcomePendingWaitMs }),
        };
        return { intent: next, result: next };
      },
    });
    if (awaiting) this.#rememberIntent(awaiting);
    return awaiting;
  }

  async settleResultByKey(
    input: RuntimeAuthRecoveryKeyParts & Readonly<{
      expectedAttemptId?: string;
      result: unknown;
      classificationResetsAtMs: number | null;
      classificationFailureKind: ConnectedServiceRuntimeFailureClassification['kind'];
    }>,
  ): Promise<RuntimeAuthRecoveryIntent | null> {
    const key = this.#buildKey(input);
    const settled = await this.#scheduler.transact<RuntimeAuthRecoveryIntent | null>({
      sessionId: key,
      transaction: (currentValue) => {
        const current = normalizeRuntimeAuthRecoveryIntent(currentValue);
        if (
          !current
          || !isPendingRuntimeAuthRecoveryStatus(current.status)
          || (input.expectedAttemptId && current.attemptId !== input.expectedAttemptId)
        ) {
          return { intent: current, result: null };
        }
        const disposition = resolveRuntimeAuthRecoveryResultDisposition({
          result: input.result,
          classificationFailureKind: input.classificationFailureKind,
          classificationResetsAtMs: input.classificationResetsAtMs,
          nowMs: this.#nowMs(),
        });
        if (!disposition) return { intent: current, result: null };
        if (disposition.kind === 'durable_wait') {
          const waiting: RuntimeAuthRecoveryIntent = {
            ...current,
            status: 'waiting',
            attemptCount: current.attemptCount + 1,
            nextRetryAtMs: disposition.nextRetryAtMs,
            lastError: disposition.reason,
            terminalAtMs: null,
            terminalReason: null,
          };
          return { intent: waiting, result: waiting };
        }
        const terminal = settleVisibleTransition({
          ...current,
          status: 'cancelled',
          nextRetryAtMs: null,
          terminalAtMs: this.#nowMs(),
          terminalReason: disposition.reason,
          lastError: disposition.reason,
        }, 'terminal', disposition.reason);
        return { intent: terminal, result: terminal };
      },
    });
    if (settled) this.#rememberIntent(settled);
    return settled;
  }

  /**
   * Proof-gated clear keyed by recovery identity (B1 / provider-outcome contract):
   * provider activity (or another recovered proof) reported with a recovery identity
   * clears every matching ACTIVE intent for the session as recovered. Non-recovered
   * proof kinds (intermediate evidence such as `fresh_candidate_selected`) never
   * clear — the closed proof union stays the only success boundary. Cancelled
   * intents stay terminal records. EXHAUSTED dead-letters self-heal on recovered
   * proof: the provider demonstrably working under the same recovery identity is
   * stronger evidence than a stale retry-budget verdict (incident 2026-06-12,
   * cmq8y3nlx: a defect-artifact dead-letter pinned a permanent "retry limit"
   * banner on a healthy account) — the record is removed and a terminal
   * `recovered` resolution is published as the dead-letter row's counterpart.
   */
  async markProviderOutcomeProofByIdentity(
    input: RuntimeAuthRecoveryProofByIdentityInput,
  ): Promise<ReadonlyArray<RuntimeAuthRecoveryIntent>> {
    if (!isRecoveredProviderOutcomeProof(input.proofKind)) return [];
    const matches = this.#readForSession(input.sessionId).filter((intent) => (
      (isPendingRuntimeAuthRecoveryStatus(intent.status) || intent.status === 'exhausted')
      && isApplicableRuntimeAuthRecoveryProof(intent, input)
    ));
    const cleared: RuntimeAuthRecoveryIntent[] = [];
    for (const intent of matches) {
      if (intent.status === 'exhausted') {
        const resolved = await this.#resolveDeadLetterByProviderOutcomeProof(intent, input);
        if (resolved) cleared.push(resolved);
        continue;
      }
      const succeeded = await this.#markSucceededByProviderOutcomeProof(intent, input);
      if (succeeded) cleared.push(succeeded);
    }
    return cleared;
  }

  async #markSucceededByProviderOutcomeProof(
    intent: RuntimeAuthRecoveryIntent,
    proof: RuntimeAuthRecoveryProofByIdentityInput,
  ): Promise<RuntimeAuthRecoveryIntent | null> {
    const key = this.#keyForIntent(intent);
    const recovered = await this.#scheduler.transact<RuntimeAuthRecoveryIntent | null>({
      sessionId: key,
      transaction: (currentValue) => {
        const current = normalizeRuntimeAuthRecoveryIntent(currentValue);
        if (
          !current
          || !isPendingRuntimeAuthRecoveryStatus(current.status)
          || current.attemptId !== intent.attemptId
          || current.armedAtMs !== intent.armedAtMs
          || !isApplicableRuntimeAuthRecoveryProof(current, proof)
        ) {
          return { intent: current, result: null };
        }
        if (!current.attemptId) return { intent: null, result: current };
        const next = settleVisibleTransition({
          ...current,
          status: 'recovered',
          nextRetryAtMs: null,
          terminalAtMs: this.#nowMs(),
          terminalReason: 'provider_outcome_proven',
        }, 'recovered', 'provider_outcome_proven');
        return { intent: next, result: next };
      },
    });
    if (!recovered) return null;
    this.#emit({
      event: 'runtime_auth_recovery_success',
      sessionId: recovered.sessionId,
      serviceId: recovered.serviceId,
      groupId: recovered.groupId,
      profileId: recovered.profileId,
      failurePhase: recovered.failurePhase,
      attemptCount: recovered.attemptCount,
    });
    return recovered;
  }

  async #resolveDeadLetterByProviderOutcomeProof(
    intent: RuntimeAuthRecoveryIntent,
    proof: RuntimeAuthRecoveryProofByIdentityInput,
  ): Promise<RuntimeAuthRecoveryIntent | null> {
    const key = this.#keyForIntent(intent);
    const cleared = await this.#scheduler.transact<RuntimeAuthRecoveryIntent | null>({
      sessionId: key,
      transaction: (currentValue) => {
        const current = normalizeRuntimeAuthRecoveryIntent(currentValue);
        if (
          !current
          || current.status !== 'exhausted'
          || current.attemptId !== intent.attemptId
          || current.armedAtMs !== intent.armedAtMs
          || !isApplicableRuntimeAuthRecoveryProof(current, proof)
        ) {
          return { intent: current, result: null };
        }
        return { intent: null, result: current };
      },
    });
    if (!cleared) return null;
    this.#recoveryKeysBySessionId.get(cleared.sessionId)?.delete(key);
    const reason = 'dead_letter_resolved_by_provider_outcome_proof';
    const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
      status: 'recovered',
      classification: cleared.classification,
      attempt: cleared.attemptCount,
      terminal: true,
      reason,
    });
    this.#emit({
      event: 'runtime_auth_recovery_success',
      sessionId: cleared.sessionId,
      serviceId: cleared.serviceId,
      groupId: cleared.groupId,
      profileId: cleared.profileId,
      failurePhase: cleared.failurePhase,
      attemptCount: cleared.attemptCount,
      reason,
      ...(transcriptEvent ? { transcriptEvent } : {}),
    });
    return cleared;
  }

  #readSupersededPendingProofIntents(input: Readonly<{
    sessionId: string;
    serviceId: string;
    profileId: string | null;
    groupId: string | null;
    recoveryKey: string;
  }>): ReadonlyArray<SupersededPendingProofIntent> {
    if (!input.profileId) return [];
    return this.#readForSession(input.sessionId)
      .map((intent): SupersededPendingProofIntent => ({
        key: this.#keyForIntent(intent),
        intent,
      }))
      .filter(({ key, intent }) => key !== input.recoveryKey
        && intent.status === 'resumed_awaiting_proof'
        && intent.serviceId === input.serviceId
        && intent.groupId === input.groupId
        && intent.pendingTargetProfileId === input.profileId);
  }

  async #clearSupersededPendingProofIntents(
    superseded: ReadonlyArray<SupersededPendingProofIntent>,
  ): Promise<void> {
    for (const { key, intent } of superseded) {
      await this.#scheduler.clear({ sessionId: key });
      this.#recoveryKeysBySessionId.get(intent.sessionId)?.delete(key);
    }
  }

  async #enqueue(input: Readonly<{
    reportId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    failurePhase: RuntimeAuthRecoveryPhase;
    failureReason?: string;
    lastError: string;
    errorClassification: DaemonServerWorkErrorClassification | null;
    terminalReason: string | null;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    transition: RuntimeAuthRecoveryTransition;
    projectVisibleEvent: boolean;
    expectedAttemptId?: string;
  }>): Promise<RuntimeAuthRecoveryScheduleResult> {
    const classification = sanitizeConnectedServiceRuntimeFailureClassification(input.classification);
    if (!classification) {
      this.#emit({
        event: 'runtime_auth_recovery_terminal',
        sessionId: input.sessionId,
        failurePhase: input.failurePhase,
        reason: 'unclassified_runtime_auth_failure',
        errorClassification: input.errorClassification,
      });
      return {
        status: 'terminal_non_retry',
        retryable: false,
        reason: 'unclassified_runtime_auth_failure',
        errorClassification: input.errorClassification,
      };
    }

    if (input.terminalReason) {
      const terminalReason = input.terminalReason;
      let accepted = true;
      if (input.expectedAttemptId) {
        const recoveryKey = this.#buildKey({
          sessionId: input.sessionId,
          serviceId: classification.serviceId,
          profileId: classification.profileId ?? null,
          groupId: classification.groupId ?? null,
          failingAccessTokenFingerprint: classification.failingAccessTokenFingerprint ?? null,
        });
        accepted = await this.#scheduler.transact<boolean>({
          sessionId: recoveryKey,
          transaction: (currentValue) => {
            const current = normalizeRuntimeAuthRecoveryIntent(currentValue);
            if (!current || current.attemptId !== input.expectedAttemptId || transitionRank(current.lastSettledTransition) >= transitionRank('terminal')) {
              return { intent: current, result: false };
            }
            const terminal = settleVisibleTransition({
              ...current,
              status: 'cancelled',
              nextRetryAtMs: null,
              terminalAtMs: this.#nowMs(),
              terminalReason,
              lastError: input.lastError,
              lastErrorClassification: input.errorClassification,
            }, 'terminal', terminalReason);
            return { intent: terminal, result: true };
          },
        });
      }
      if (accepted) this.#emit({
        event: 'runtime_auth_recovery_terminal',
        sessionId: input.sessionId,
        serviceId: classification.serviceId,
        groupId: classification.groupId,
        profileId: classification.profileId,
        failurePhase: input.failurePhase,
        reason: terminalReason,
        errorClassification: input.errorClassification,
        failureKind: classification.kind,
      });
      return {
        status: 'terminal_non_retry',
        retryable: false,
        reason: terminalReason,
        errorClassification: input.errorClassification,
      };
    }

    const nowMs = this.#nowMs();
    const jitterMs = Math.max(0, Math.floor(this.#jitterMs()));
    const profileId = classification.profileId ?? null;
    const groupId = classification.groupId ?? null;
    const recoveryKey = this.#buildKey({
      sessionId: input.sessionId,
      serviceId: classification.serviceId,
      profileId,
      groupId,
      failingAccessTokenFingerprint: classification.failingAccessTokenFingerprint ?? null,
    });
    const supersededPendingProof = this.#readSupersededPendingProofIntents({
      sessionId: input.sessionId,
      serviceId: classification.serviceId,
      profileId,
      groupId,
      recoveryKey,
    });
    const inheritedAttemptCount = supersededPendingProof.reduce(
      (maxAttemptCount, { intent }) => Math.max(maxAttemptCount, intent.attemptCount),
      0,
    );
    const inheritedPendingTarget = supersededPendingProof[0]?.intent ?? null;
    const nextRetryAtMs = resolveInitialRetryAtMs({
      nowMs,
      baseBackoffMs: this.#baseBackoffMs,
      jitterMs,
      errorClassification: input.errorClassification ?? { kind: 'protocol_error', retryable: true },
    });
    const attemptId = input.expectedAttemptId
      ?? (input.reportId ? `runtime-auth-attempt:${input.reportId.replace(/^runtime-auth-report:/, '')}` : undefined);
    const uxDiagnostic = input.projectVisibleEvent
      ? buildRuntimeAuthRecoveryScheduledUxDiagnostic({
          classification,
          nextRetryAtMs,
          reason: input.failureReason ?? 'runtime_auth_recovery_scheduled',
        })
      : null;
    const transcriptEvent = uxDiagnostic
      ? buildRuntimeAuthRecoveryTranscriptEvent({
          status: 'retry_scheduled',
          classification,
          uxDiagnostic,
          nextRetryAtMs,
          terminal: false,
          reason: input.failureReason ?? 'runtime_auth_recovery_scheduled',
        })
      : null;
    const intent: RuntimeAuthRecoveryIntent = {
      v: 1,
      ...(attemptId ? {
        attemptId,
        lastSettledTransition: input.transition,
      } : {}),
      ...(attemptId && transcriptEvent ? {
        pendingVisibleEvents: [{ attemptId, transition: input.transition, transcriptEvent }],
      } : {}),
      sessionId: input.sessionId,
      serviceId: classification.serviceId,
      profileId,
      groupId,
      resumePromptMode: input.resumePromptMode === 'off' || input.resumePromptMode === 'custom'
        ? input.resumePromptMode
        : 'standard',
      status: 'waiting',
      armedAtMs: nowMs,
      failurePhase: input.failurePhase,
      failureReason: input.failureReason ?? input.terminalReason ?? (
        input.failurePhase === 'handler' ? 'handler_transient_failure' : 'apply_transient_failure'
      ),
      classification,
      switchesThisTurn: input.switchesThisTurn,
      attemptCount: inheritedAttemptCount,
      maxAttempts: this.#maxAttempts,
      // The control route owns the one initial in-band attempt. Only a typed
      // handler/apply failure transitions this intent to `scheduled` and arms
      // the durable retry timer.
      nextRetryAtMs: input.transition === 'working' ? null : nextRetryAtMs,
      lastError: input.lastError,
      lastErrorClassification: input.errorClassification,
      pendingTargetProfileId: inheritedPendingTarget?.pendingTargetProfileId ?? null,
      pendingTargetGeneration: inheritedPendingTarget?.pendingTargetGeneration ?? null,
      pendingTargetCredentialRevision: inheritedPendingTarget?.pendingTargetCredentialRevision ?? null,
      terminalAtMs: null,
      terminalReason: null,
    };
    this.#rememberIntent(intent);
    const settlement: Readonly<{ accepted: boolean; intent: RuntimeAuthRecoveryIntent | null }> = input.expectedAttemptId
      ? await this.#scheduler.transact<Readonly<{ accepted: boolean; intent: RuntimeAuthRecoveryIntent | null }>>({
          sessionId: recoveryKey,
          transaction: (currentValue) => {
            const current = normalizeRuntimeAuthRecoveryIntent(currentValue);
            if (
              !current
              || current.attemptId !== input.expectedAttemptId
              || transitionRank(input.transition) <= transitionRank(current.lastSettledTransition)
            ) {
              return { intent: current, result: { accepted: false as const, intent: current } };
            }
            const merged = mergeRuntimeAuthRecoveryIntent(current, intent);
            const pendingVisibleEvents = mergePendingVisibleEvents(current.pendingVisibleEvents, intent.pendingVisibleEvents);
            const accepted: RuntimeAuthRecoveryIntent = {
              ...merged,
              attemptId: current.attemptId,
              lastSettledTransition: input.transition,
              ...(pendingVisibleEvents ? { pendingVisibleEvents } : {}),
            };
            return { intent: accepted, result: { accepted: true as const, intent: accepted } };
          },
        })
      : {
          accepted: true as const,
          intent: await this.#scheduler.upsertMerged({
            sessionId: recoveryKey,
            intent,
            merge: mergeRuntimeAuthRecoveryIntent,
          }),
        };
    const persistedIntent = settlement.intent;
    if (!persistedIntent) {
      return {
        status: 'terminal_non_retry',
        retryable: false,
        reason: 'runtime_auth_recovery_stale_settlement',
      };
    }
    if (persistedIntent.status === 'cancelled' || persistedIntent.status === 'exhausted') {
      return {
        status: 'terminal_non_retry',
        retryable: false,
        reason: `runtime_auth_recovery_${persistedIntent.status}`,
        errorClassification: persistedIntent.lastErrorClassification,
      };
    }
    await this.#clearSupersededPendingProofIntents(supersededPendingProof);
    if (settlement.accepted && input.projectVisibleEvent) this.#emit({
      event: 'runtime_auth_recovery_enqueue',
      sessionId: input.sessionId,
      serviceId: classification.serviceId,
      groupId: classification.groupId,
      profileId: classification.profileId,
      failurePhase: input.failurePhase,
      attemptCount: persistedIntent.attemptCount,
      nextRetryAtMs: persistedIntent.nextRetryAtMs,
      errorClassification: input.errorClassification,
      failureKind: classification.kind,
      ...(uxDiagnostic ? { uxDiagnostic } : {}),
      ...(transcriptEvent ? { transcriptEvent } : {}),
    });
    return {
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: persistedIntent.nextRetryAtMs ?? nextRetryAtMs,
      attemptCount: persistedIntent.attemptCount,
      maxAttempts: persistedIntent.maxAttempts,
      ...(persistedIntent.attemptId ? { attemptId: persistedIntent.attemptId } : {}),
      ...(persistedIntent.lastSettledTransition ? { transition: persistedIntent.lastSettledTransition } : {}),
      resumePromptMode: persistedIntent.resumePromptMode === 'off' || persistedIntent.resumePromptMode === 'custom'
        ? persistedIntent.resumePromptMode
        : 'standard',
    };
  }

  #emit(event: RuntimeAuthRecoveryDiagnostic): void {
    this.#recordDiagnostic?.(event);
  }
}
