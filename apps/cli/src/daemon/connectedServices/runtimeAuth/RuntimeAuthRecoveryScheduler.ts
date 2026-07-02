import { classifyDaemonServerWorkError } from '@/daemon/serverWork';
import type {
  DaemonServerWorkErrorClassification,
  DaemonServerWorkErrorKind,
} from '@/daemon/serverWork/types';
import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
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

type RuntimeAuthRecoveryStatus = 'waiting' | 'checking' | 'resumed_awaiting_proof' | 'cancelled' | 'exhausted';
type RuntimeAuthRecoveryPhase = 'handler' | 'apply';

export type RuntimeAuthRecoveryIntent = Readonly<{
  v: 1;
  sessionId: string;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
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
    }>
  | Readonly<{
      status: 'terminal_non_retry';
      retryable: false;
      reason: string;
      errorClassification?: DaemonServerWorkErrorClassification | null;
    }>;

export type RuntimeAuthRecoverySchedulerLike = Readonly<{
  beginClassifiedFailure(input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>): Promise<RuntimeAuthRecoveryScheduleResult>;
  enqueueHandlerFailure(input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    error: unknown;
  }>): Promise<RuntimeAuthRecoveryScheduleResult>;
  enqueueApplyFailure(input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    result: unknown;
  }>): Promise<RuntimeAuthRecoveryScheduleResult>;
  read(sessionId: string): RuntimeAuthRecoveryIntent | null;
  readForSession(sessionId: string): ReadonlyArray<RuntimeAuthRecoveryIntent>;
  hydrate(): ReadonlyArray<RuntimeAuthRecoveryIntent>;
  wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'manual' }>): Promise<Readonly<{ status: string }>>;
  cancel(input: Readonly<{ sessionId: string }>): Promise<RuntimeAuthRecoveryIntent | null>;
  cancelByKey(input: RuntimeAuthRecoveryKeyParts): Promise<RuntimeAuthRecoveryIntent | null>;
  markSucceededByKey(input: RuntimeAuthRecoveryKeyParts): Promise<RuntimeAuthRecoveryIntent | null>;
  markAwaitingProviderOutcomeProofByKey?: (input: RuntimeAuthRecoveryKeyParts) =>
    Promise<RuntimeAuthRecoveryIntent | null>;
  markProviderOutcomeProofByIdentity?: (input: RuntimeAuthRecoveryProofByIdentityInput) =>
    Promise<ReadonlyArray<RuntimeAuthRecoveryIntent>>;
  dispose?: () => void;
}>;

export type RuntimeAuthRecoveryProofByIdentityInput = Readonly<{
  sessionId: string;
  proofKind: ProviderOutcomeProofKind;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
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
const DEFAULT_RUNTIME_AUTH_RECOVERY_GROUP_EXHAUSTED_WAIT_FLOOR_MS = 30_000;
const DEFAULT_RUNTIME_AUTH_RECOVERY_SWITCH_LIMIT_WAIT_FLOOR_MS = 5 * 60_000;

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
    || value === 'exhausted';
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

function normalizeRuntimeAuthRecoveryIntent(value: unknown): RuntimeAuthRecoveryIntent | null {
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
  return {
    ...(record as unknown as RuntimeAuthRecoveryIntent),
    sessionId: readString(record.sessionId) ?? '',
    serviceId: readString(record.serviceId) ?? classification.serviceId,
    profileId: readString(record.profileId) ?? classification.profileId,
    groupId: readString(record.groupId) ?? classification.groupId,
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

function readSwitchAttemptResultRecord(result: unknown): Record<string, unknown> | null {
  const outer = asRecord(result);
  return asRecord(outer?.result) ?? outer;
}

function readFutureMs(value: unknown, nowMs: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > nowMs
    ? Math.trunc(value)
    : null;
}

type RuntimeAuthRecoveryDurableWait = Readonly<{
  nextRetryAtMs: number;
  reason: 'no_eligible_member' | 'switch_limit_reached' | 'awaiting_limit_reset';
}>;

// F0 extension (incident Jun-11 F-NEW-1 / FIX-4): non-group (profile-pinned/native) selections
// have no switch target, but a WAITABLE limit failure with a computable future reset is a
// durable wait, not a terminal `recovery_action_required` / `not_group_selection`.
// Credential/sharing action kinds stay terminal — no reset horizon makes a reconnect
// unnecessary.
const RUNTIME_AUTH_WAITABLE_ACTION_REQUIRED_KINDS: ReadonlySet<string> = new Set([
  'profile_action_required',
  'connected_service_required',
]);
const RUNTIME_AUTH_WAITABLE_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'usage_limit',
  'rate_limit',
  'temporary_throttle',
]);

function resolveNonGroupDurableWaitCandidateMs(input: Readonly<{
  switchResult: Readonly<Record<string, unknown>>;
  status: string;
  intent: RuntimeAuthRecoveryIntent;
  nowMs: number;
}>): number | null {
  if (input.status === 'recovery_action_required') {
    const action = asRecord(input.switchResult.action);
    const actionKind = readString(action?.kind);
    const actionReason = readString(action?.reason);
    if (!actionKind || !RUNTIME_AUTH_WAITABLE_ACTION_REQUIRED_KINDS.has(actionKind)) return null;
    if (!actionReason || !RUNTIME_AUTH_WAITABLE_FAILURE_REASONS.has(actionReason)) return null;
  } else if (input.status === 'not_group_selection') {
    if (!RUNTIME_AUTH_WAITABLE_FAILURE_REASONS.has(input.intent.classification.kind)) return null;
  } else {
    return null;
  }
  // Only PROVIDER reset evidence qualifies — intentionally NOT the intent's own scheduler
  // backoff (which is near-now and would convert "no computable reset → terminal" into an
  // endless retry loop for selections that have nothing to wait for). No floor either.
  return readFutureMs(input.intent.classification.resetsAtMs ?? null, input.nowMs);
}

function resolveEarliestFutureWaitCandidateMs(
  candidates: ReadonlyArray<number | null>,
  nowMs: number,
): number | null {
  const future = candidates.filter((value): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > nowMs
  ));
  if (future.length === 0) return null;
  return Math.min(...future);
}

function readExcludedMemberRetryAtMsCandidates(
  switchResult: Readonly<Record<string, unknown>>,
): ReadonlyArray<number | null> {
  if (!Array.isArray(switchResult.excluded)) return [];
  return switchResult.excluded.map((entry) => (
    asRecord(entry) ? readNonNegativeNumber(entry.retryAtMs) : null
  ));
}

function resolveRuntimeAuthRecoveryDurableWait(input: Readonly<{
  result: unknown;
  intent: RuntimeAuthRecoveryIntent;
  nowMs: number;
}>): RuntimeAuthRecoveryDurableWait | null {
  const switchResult = readSwitchAttemptResultRecord(input.result);
  const status = readSwitchAttemptResultStatus(input.result);
  if (!switchResult || !status) return null;
  if (status === 'no_eligible_member' && switchResult.groupExhausted === true) {
    // The switch result's own retryAtMs/resetsAtMs are the authoritative group-reset
    // evidence and win when in the future; broader candidates (excluded-member
    // retries, the classification reset, the intent's own schedule) are fallbacks,
    // with a floor so the wait can never collapse to `now`.
    const candidate = readFutureMs(switchResult.retryAtMs, input.nowMs)
      ?? readFutureMs(switchResult.resetsAtMs, input.nowMs)
      ?? resolveEarliestFutureWaitCandidateMs([
        ...readExcludedMemberRetryAtMsCandidates(switchResult),
        input.intent.classification.resetsAtMs ?? null,
        input.intent.nextRetryAtMs,
      ], input.nowMs);
    return {
      reason: 'no_eligible_member',
      nextRetryAtMs: candidate ?? input.nowMs + DEFAULT_RUNTIME_AUTH_RECOVERY_GROUP_EXHAUSTED_WAIT_FLOOR_MS,
    };
  }
  if (status === 'switch_limit_reached') {
    const candidate = resolveEarliestFutureWaitCandidateMs([
      input.intent.classification.resetsAtMs ?? null,
      input.intent.nextRetryAtMs,
    ], input.nowMs);
    return {
      reason: 'switch_limit_reached',
      nextRetryAtMs: candidate ?? input.nowMs + DEFAULT_RUNTIME_AUTH_RECOVERY_SWITCH_LIMIT_WAIT_FLOOR_MS,
    };
  }
  const nonGroupWaitCandidateMs = resolveNonGroupDurableWaitCandidateMs({
    switchResult,
    status,
    intent: input.intent,
    nowMs: input.nowMs,
  });
  if (nonGroupWaitCandidateMs !== null) {
    return {
      reason: 'awaiting_limit_reset',
      nextRetryAtMs: nonGroupWaitCandidateMs,
    };
  }
  return null;
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

function classifyApplyFailure(result: unknown): Readonly<{
  classification: DaemonServerWorkErrorClassification | null;
  lastError: string;
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
    failureReason: failure.errorCode,
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
  intent: Pick<RuntimeAuthRecoveryIntent, 'serviceId' | 'groupId' | 'profileId'>,
  identity: Readonly<{ serviceId: string; groupId: string | null; profileId: string | null }>,
): boolean {
  if (intent.serviceId !== identity.serviceId) return false;
  if (identity.groupId) {
    return intent.groupId === identity.groupId;
  }
  return intent.groupId === null && intent.profileId === identity.profileId;
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

function mergeRuntimeAuthRecoveryIntent(
  previous: RuntimeAuthRecoveryIntent | null,
  next: RuntimeAuthRecoveryIntent,
): RuntimeAuthRecoveryIntent {
  if (!previous || !hasSameRuntimeAuthRecoveryKey(previous, next)) return next;
  if (previous.status === 'cancelled' || previous.status === 'exhausted' || previous.status === 'checking') {
    return previous;
  }
  return {
    ...next,
    status: previous.status,
    armedAtMs: previous.armedAtMs,
    attemptCount: previous.attemptCount,
    maxAttempts: resolveStricterMaxAttempts(previous.maxAttempts, next.maxAttempts),
    nextRetryAtMs: resolveEarlierRetryAtMs(previous.nextRetryAtMs, next.nextRetryAtMs),
    pendingTargetProfileId: next.pendingTargetProfileId ?? previous.pendingTargetProfileId ?? null,
    pendingTargetGeneration: next.pendingTargetGeneration ?? previous.pendingTargetGeneration ?? null,
    terminalAtMs: next.terminalAtMs ?? null,
    terminalReason: next.terminalReason ?? null,
  };
}

type RuntimeAuthPendingProofTarget = Readonly<{
  activeProfileId: string | null;
  generation: number | null;
}>;

function readPendingProofTarget(result: unknown): RuntimeAuthPendingProofTarget | null {
  const switchResult = readRuntimeAuthRecoverySwitchResult(result);
  if (!switchResult) return null;
  const status = readString(switchResult.status);
  if (status !== 'switched' && status !== 'observed_generation') return null;
  return {
    activeProfileId: readString(switchResult.activeProfileId),
    generation: readNonNegativeNumber(switchResult.generation),
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
    store?: DurableBackoffRecoveryStore<RuntimeAuthRecoveryIntent>;
    recover: (input: Readonly<{
      sessionId: string;
      switchesThisTurn: number;
      classification: ConnectedServiceRuntimeFailureClassification;
      recoveryInvocationSource: 'scheduler_retry';
    }>) => Promise<unknown>;
    gate?: (input: { sessionId: string; intent: RuntimeAuthRecoveryIntent }) =>
      | Readonly<{ status: 'open' }>
      | Readonly<{ status: 'delayed'; retryAtMs: number; reason: string }>;
    recordDiagnostic?: (event: RuntimeAuthRecoveryDiagnostic) => void;
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
      store: deps.store,
      normalizeIntent: normalizeRuntimeAuthRecoveryIntent,
      getStatus: (intent) => intent.status === 'resumed_awaiting_proof' ? 'waiting' : intent.status,
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
        ...intent,
        status: 'cancelled',
        nextRetryAtMs: null,
        terminalAtMs: deps.nowMs(),
      }),
      markExhausted: (intent, next) => ({
        ...intent,
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
        });
        try {
          const result = await deps.recover({
            sessionId: intent.sessionId,
            switchesThisTurn: intent.switchesThisTurn,
            classification: intent.classification,
            recoveryInvocationSource: 'scheduler_retry',
          });
          if (isSuccessfulRecoveryResult(result)) return { status: 'success' as const };
          const supersededReason = readRuntimeAuthRecoverySupersededReason(result);
          if (supersededReason) {
            return { status: 'superseded' as const, reason: supersededReason };
          }
          const durableWait = resolveRuntimeAuthRecoveryDurableWait({
            result,
            intent,
            nowMs: this.#nowMs(),
          });
          if (durableWait !== null) {
            return {
              status: 'wait' as const,
              nextRetryAtMs: durableWait.nextRetryAtMs,
              lastError: durableWait.reason,
              intent: {
                ...intent,
                status: 'waiting',
                attemptCount: Math.max(0, intent.attemptCount - 1),
                nextRetryAtMs: durableWait.nextRetryAtMs,
                lastError: durableWait.reason,
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
            const rollbackAttempt = coalescedReplay && coalescedReplayCount < this.#maxCoalescedReplays;
            return {
              status: 'wait' as const,
              lastError: 'recovery_unproven_awaiting_provider_outcome',
              intent: {
                ...intent,
                status: 'resumed_awaiting_proof',
                attemptCount: rollbackAttempt ? Math.max(0, intent.attemptCount - 1) : intent.attemptCount,
                ...(coalescedReplay ? { coalescedReplayCount: coalescedReplayCount + 1 } : {}),
                pendingTargetProfileId: pendingTarget?.activeProfileId ?? intent.pendingTargetProfileId ?? null,
                pendingTargetGeneration: pendingTarget?.generation ?? intent.pendingTargetGeneration ?? null,
              },
              ...(this.#providerOutcomePendingWaitMs === null
                ? {}
                : { nextRetryAtMs: this.#nowMs() + this.#providerOutcomePendingWaitMs }),
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
              return { status: 'terminal' as const, lastError: applyFailure.lastError };
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
      clearOnSuccess: true,
      onSuccess: ({ intent }) => {
        this.#recoveryKeysBySessionId.get(intent.sessionId)?.delete(this.#keyForIntent(intent));
        this.#emit({
          event: 'runtime_auth_recovery_success',
          sessionId: intent.sessionId,
          serviceId: intent.classification.serviceId,
          groupId: intent.classification.groupId,
          profileId: intent.classification.profileId,
          failurePhase: intent.failurePhase,
          attemptCount: intent.attemptCount,
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
          uxDiagnostic,
          ...(transcriptEvent ? { transcriptEvent } : {}),
        });
      },
  });
  }

  async beginClassifiedFailure(input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
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
    });
  }

  async enqueueHandlerFailure(input: Readonly<{
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
        terminalReason: thrownApplyFailure.classification?.retryable === true ? null : 'non_retryable_apply_failure',
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
    });
  }

  async enqueueApplyFailure(input: Readonly<{
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
      failureReason: readApplyFailureDiagnostics(input.result).errorCode ?? 'non_retryable_apply_failure',
      lastError: applyFailure?.lastError ?? 'non_retryable_apply_failure',
      errorClassification: applyFailure?.classification ?? null,
      terminalReason: applyFailure?.classification?.retryable === true ? null : 'non_retryable_apply_failure',
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
    });
  }

  #rememberIntent(intent: RuntimeAuthRecoveryIntent): void {
    const key = this.#keyForIntent(intent);
    const keys = this.#recoveryKeysBySessionId.get(intent.sessionId) ?? new Set<string>();
    keys.add(key);
    this.#recoveryKeysBySessionId.set(intent.sessionId, keys);
  }

  #readForSession(sessionId: string): ReadonlyArray<RuntimeAuthRecoveryIntent> {
    const knownKeys = this.#recoveryKeysBySessionId.get(sessionId) ?? new Set<string>();
    const intents: RuntimeAuthRecoveryIntent[] = [];
    for (const key of knownKeys) {
      const intent = this.#scheduler.read(key);
      if (!intent || intent.sessionId !== sessionId) continue;
      intents.push(intent);
    }
    if (intents.length > 0) return intents;

    for (const intent of this.#scheduler.hydrate()) {
      this.#rememberIntent(intent);
      if (intent.sessionId === sessionId) intents.push(intent);
    }
    if (intents.length > 0) return intents;

    const legacyIntent = this.#scheduler.read(sessionId);
    return legacyIntent ? [legacyIntent] : [];
  }

  /**
   * Stop all armed recovery timers (daemon shutdown). The persisted intents stay `waiting` on disk
   * so a healthy future daemon re-hydrates and re-drives them; this only prevents timers from firing
   * switch/restart work into a tearing-down daemon.
   */
  dispose(): void {
    this.#scheduler.dispose();
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

  hydrate(): ReadonlyArray<RuntimeAuthRecoveryIntent> {
    const intents = this.#scheduler.hydrate();
    for (const intent of intents) this.#rememberIntent(intent);
    return intents;
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

  async cancelByKey(input: RuntimeAuthRecoveryKeyParts): Promise<RuntimeAuthRecoveryIntent | null> {
    return await this.#scheduler.cancel({ sessionId: this.#buildKey(input) });
  }

  async markSucceededByKey(input: RuntimeAuthRecoveryKeyParts): Promise<RuntimeAuthRecoveryIntent | null> {
    const key = this.#buildKey(input);
    const cleared = await this.#scheduler.clear({ sessionId: key });
    if (!cleared) return null;
    this.#recoveryKeysBySessionId.get(cleared.sessionId)?.delete(key);
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
    input: RuntimeAuthRecoveryKeyParts,
  ): Promise<RuntimeAuthRecoveryIntent | null> {
    const key = this.#buildKey(input);
    const current = this.#scheduler.read(key);
    if (!current || !isPendingRuntimeAuthRecoveryStatus(current.status)) return null;
    const awaiting: RuntimeAuthRecoveryIntent = {
      ...current,
      status: 'resumed_awaiting_proof',
      lastError: 'recovery_unproven_awaiting_provider_outcome',
      pendingTargetProfileId: input.profileId ?? current.pendingTargetProfileId ?? null,
      pendingTargetGeneration: current.pendingTargetGeneration ?? null,
      ...(this.#providerOutcomePendingWaitMs === null
        ? {}
        : { nextRetryAtMs: this.#nowMs() + this.#providerOutcomePendingWaitMs }),
    };
    this.#rememberIntent(awaiting);
    return await this.#scheduler.upsert({
      sessionId: key,
      intent: awaiting,
    });
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
      && matchesRuntimeAuthRecoveryIdentity(intent, input)
    ));
    const cleared: RuntimeAuthRecoveryIntent[] = [];
    for (const intent of matches) {
      if (intent.status === 'exhausted') {
        const resolved = await this.#resolveDeadLetterByProviderOutcomeProof(intent);
        if (resolved) cleared.push(resolved);
        continue;
      }
      const succeeded = await this.markSucceededByKey({
        sessionId: intent.sessionId,
        serviceId: intent.serviceId,
        profileId: intent.profileId,
        groupId: intent.groupId,
      });
      if (succeeded) cleared.push(succeeded);
    }
    return cleared;
  }

  async #resolveDeadLetterByProviderOutcomeProof(
    intent: RuntimeAuthRecoveryIntent,
  ): Promise<RuntimeAuthRecoveryIntent | null> {
    const key = this.#keyForIntent(intent);
    const cleared = await this.#scheduler.clear({ sessionId: key });
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
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    failurePhase: RuntimeAuthRecoveryPhase;
    failureReason?: string;
    lastError: string;
    errorClassification: DaemonServerWorkErrorClassification | null;
    terminalReason: string | null;
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
      this.#emit({
        event: 'runtime_auth_recovery_terminal',
        sessionId: input.sessionId,
        serviceId: classification.serviceId,
        groupId: classification.groupId,
        profileId: classification.profileId,
        failurePhase: input.failurePhase,
        reason: input.terminalReason,
        errorClassification: input.errorClassification,
      });
      return {
        status: 'terminal_non_retry',
        retryable: false,
        reason: input.terminalReason,
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
    const intent: RuntimeAuthRecoveryIntent = {
      v: 1,
      sessionId: input.sessionId,
      serviceId: classification.serviceId,
      profileId,
      groupId,
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
      nextRetryAtMs,
      lastError: input.lastError,
      lastErrorClassification: input.errorClassification,
      pendingTargetProfileId: inheritedPendingTarget?.pendingTargetProfileId ?? null,
      pendingTargetGeneration: inheritedPendingTarget?.pendingTargetGeneration ?? null,
      terminalAtMs: null,
      terminalReason: null,
    };
    this.#rememberIntent(intent);
    const persistedIntent = await this.#scheduler.upsertMerged({
      sessionId: recoveryKey,
      intent,
      merge: mergeRuntimeAuthRecoveryIntent,
    });
    if (persistedIntent.status === 'cancelled' || persistedIntent.status === 'exhausted') {
      return {
        status: 'terminal_non_retry',
        retryable: false,
        reason: `runtime_auth_recovery_${persistedIntent.status}`,
        errorClassification: persistedIntent.lastErrorClassification,
      };
    }
    await this.#clearSupersededPendingProofIntents(supersededPendingProof);
    const uxDiagnostic = buildRuntimeAuthRecoveryScheduledUxDiagnostic({
      classification,
      nextRetryAtMs: persistedIntent.nextRetryAtMs,
      reason: persistedIntent.failureReason,
    });
    const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
      status: 'retry_scheduled',
      classification,
      uxDiagnostic,
      nextRetryAtMs: persistedIntent.nextRetryAtMs,
      terminal: false,
      reason: persistedIntent.failureReason,
    });
    this.#emit({
      event: 'runtime_auth_recovery_enqueue',
      sessionId: input.sessionId,
      serviceId: classification.serviceId,
      groupId: classification.groupId,
      profileId: classification.profileId,
      failurePhase: input.failurePhase,
      attemptCount: persistedIntent.attemptCount,
      nextRetryAtMs: persistedIntent.nextRetryAtMs,
      errorClassification: input.errorClassification,
      uxDiagnostic,
      ...(transcriptEvent ? { transcriptEvent } : {}),
    });
    return {
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: persistedIntent.nextRetryAtMs ?? nextRetryAtMs,
      attemptCount: persistedIntent.attemptCount,
      maxAttempts: persistedIntent.maxAttempts,
    };
  }

  #emit(event: RuntimeAuthRecoveryDiagnostic): void {
    this.#recordDiagnostic?.(event);
  }
}
