import type { DaemonServerWorkErrorClassification, DaemonServerWorkErrorKind } from '@/daemon/serverWork/types';
import { isDeepStrictEqual } from 'node:util';
import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';
import {
  DurableBackoffRecoveryScheduler,
  type DurableRecoveryGateResult,
  type DurableRecoveryStore,
} from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  TranscriptRawAgentEventV1Schema,
  type ConnectedServiceUxDiagnosticV1,
} from '@happier-dev/protocol';
import { buildConnectedServiceUxDiagnostic } from '../diagnostics/connectedServiceUxDiagnostics';
import { sanitizeConnectedServiceDiagnosticString } from '../diagnostics/sanitizeConnectedServiceDiagnosticString';
import {
  isRecoveredProviderOutcomeProof,
  isTerminalProviderOutcomeProof,
  type ProviderOutcomeProofKind,
} from '../recovery/providerOutcomeProof';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { readConnectedServiceAuthGenerationApplyFailure } from './connectedServiceAuthGenerationApplyFailure';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './sanitizeConnectedServiceRuntimeFailureClassification';
import {
  isProvenRuntimeAuthRecoverySuccess,
  readRuntimeAuthRecoverySwitchResult,
  resolveRuntimeAuthRecoveryProof,
} from './resolveRuntimeAuthRecoveryOutcome';
import { resolveRuntimeAuthRecoveryResultDisposition } from './resolveRuntimeAuthRecoveryResultDisposition';
import { buildRuntimeAuthRecoveryKey } from './recoveryKey/runtimeAuthRecoveryKey';
import {
  buildRuntimeAuthRecoveryScheduledUxDiagnostic,
  buildRuntimeAuthRecoveryTranscriptEvent,
  type ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1,
} from './projection/connectedServiceRuntimeAuthRecoveryProjection';

type RuntimeAuthRecoveryIntentStatus = 'waiting' | 'checking' | 'resumed_awaiting_proof' | 'cancelled' | 'exhausted' | 'recovered';
type RuntimeAuthRecoveryFailurePhase = 'handler' | 'apply';
export type RuntimeAuthRecoveryTransition = 'working' | 'scheduled' | 'terminal' | 'recovered';

export type RuntimeAuthRecoveryPendingVisibleEvent = Readonly<{
  attemptId: string;
  transition: RuntimeAuthRecoveryTransition;
  transcriptEvent: ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1;
}>;

export type RuntimeAuthRecoveryVisibleEventDelivery = RuntimeAuthRecoveryPendingVisibleEvent & Readonly<{
  sessionId: string;
  recoveryIntent: RuntimeAuthRecoveryIntent;
}>;

export type RuntimeAuthRecoveryIntakeResult = Readonly<{
  status: string;
  retryable: boolean;
  nextRetryAtMs?: number | null;
  attemptId?: string;
  transition?: RuntimeAuthRecoveryTransition;
  resumePromptMode?: 'standard' | 'off' | 'custom';
}>;

export type RuntimeAuthRecoveryIntent = Readonly<{
  v: 1 | 2;
  attemptId?: string;
  lastSettledTransition?: RuntimeAuthRecoveryTransition;
  pendingVisibleEvents?: ReadonlyArray<RuntimeAuthRecoveryPendingVisibleEvent>;
  sessionId: string;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  resumePromptMode?: 'standard' | 'off' | 'custom';
  status: RuntimeAuthRecoveryIntentStatus;
  armedAtMs: number;
  nextRetryAtMs: number | null;
  attemptCount: number;
  maxAttempts: number;
  // S2 degraded-retry track. Degraded lifecycle/endpoint-unavailable outcomes
  // (daemon shutting down, control endpoint unreachable) are a transient local
  // condition, not a provider failure. They must NOT advance `attemptCount` toward
  // dead-letter; instead they advance this separate, much larger budget so a long
  // local outage can be waited out without prematurely dead-lettering a recoverable
  // session. It is still bounded (cannot wait forever).
  degradedAttemptCount?: number;
  // RD-REC-15 / F4: bounded coalesced-replay budget. When a wake reproduces the
  // SAME pending proof target for a stale-profile intent (no new information),
  // the attempt rollback must not make `resumed_awaiting_proof` unbounded — each
  // coalesced replay re-runs a full switch pipeline. Once this budget is spent,
  // replays consume the normal attempt budget so the recovery settles terminal.
  coalescedReplayCount?: number;
  switchesThisTurn: number;
  classification: ConnectedServiceRuntimeFailureClassification;
  failurePhase: RuntimeAuthRecoveryFailurePhase;
  failureReason: string;
  lastError: string | null;
  lastErrorClassification: DaemonServerWorkErrorClassification | null;
  pendingTargetProfileId?: string | null;
  pendingTargetGeneration?: number | null;
  terminalAtMs?: number | null;
  terminalReason?: string | null;
}>;

export type RuntimeAuthRecoveryDiagnostic = Readonly<{
  event:
    | 'runtime_auth_recovery_enqueue'
    | 'runtime_auth_recovery_retry'
    | 'runtime_auth_recovery_success'
    | 'runtime_auth_recovery_dead_letter'
    | 'runtime_auth_recovery_terminal'
    | 'runtime_auth_recovery_superseded'
    | 'runtime_auth_recovery_delayed';
  sessionId: string;
  serviceId: string;
  groupId: string | null;
  profileId: string | null;
  failurePhase?: RuntimeAuthRecoveryFailurePhase;
  reason?: string;
  attemptCount?: number;
  nextRetryAtMs?: number | null;
  classification?: DaemonServerWorkErrorClassification | null;
  /**
   * The ORIGINAL runtime failure kind (e.g. `usage_limit`) before it is mapped to a
   * `DaemonServerWorkErrorClassification` retry class (`usage_limit` → `rate_limited`). Carried
   * alongside the mapped `classification` so log readers see the real cause: the mapped-only view
   * renamed `usage_limit` to `rate_limited` and misled a live investigation (2026-07-10). The retry
   * class mapping itself is unchanged — this is diagnostics only.
   */
  failureKind?: ConnectedServiceRuntimeFailureClassification['kind'];
  uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
  transcriptEvent?: ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1;
  attemptId?: string;
  transition?: RuntimeAuthRecoveryTransition;
}>;

export type RuntimeAuthRecoverySchedulerDeps = Readonly<{
  nowMs: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: () => number;
  maxAttempts?: number;
  providerOutcomePendingWaitMs?: number;
  // S2: bounded degraded-retry budget for endpoint/lifecycle-unavailable outcomes (defaults apply).
  maxDegradedAttempts?: number;
  degradedBackoffMs?: number;
  // RD-REC-15: bounded coalesced stale-profile replay budget (defaults apply).
  maxCoalescedReplays?: number;
  recover: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    resumePromptMode: 'standard' | 'off' | 'custom';
    source: 'scheduler_retry';
  }>) => Promise<unknown>;
  gate?: (input: Readonly<{ sessionId: string; intent: RuntimeAuthRecoveryIntent }>) => DurableRecoveryGateResult;
  recordDiagnostic?: (event: RuntimeAuthRecoveryDiagnostic) => void;
  durableStore?: DurableRecoveryStore<RuntimeAuthRecoveryIntent>;
}>;

type RetryDecision =
  | Readonly<{
      retryable: true;
      classification: DaemonServerWorkErrorClassification;
      failurePhase: RuntimeAuthRecoveryFailurePhase;
      failureReason: string;
      lastError: string | null;
    }>
  | Readonly<{
      retryable: false;
      classification: DaemonServerWorkErrorClassification | null;
      reason: string;
      failurePhase: RuntimeAuthRecoveryFailurePhase;
      lastError: string | null;
    }>;

const DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS = 5;
const DEFAULT_RUNTIME_AUTH_RECOVERY_TERMINAL_RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;
// S2: degraded retries (endpoint/lifecycle unavailable) get their own, much larger budget so a
// long local outage can be waited out without burning the normal attempt budget. Still bounded:
// once this many consecutive degraded retries occur the recovery becomes action-required rather
// than waiting forever. With a ~minute degraded backoff cap this is on the order of an hour.
const DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_DEGRADED_ATTEMPTS = 60;
const DEFAULT_RUNTIME_AUTH_RECOVERY_DEGRADED_BACKOFF_MS = 60_000;
// RD-REC-15: with the ~5min provider-outcome pending wait this allows about an
// hour of attempt-free coalesced replays before the normal attempt budget takes
// over and settles the recovery terminal.
const DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_COALESCED_REPLAYS = 12;
const RUNTIME_AUTH_RECOVERY_UNPROVEN_PROVIDER_OUTCOME_ERROR = 'recovery_unproven_awaiting_provider_outcome';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  const number = readNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function readResumePromptMode(value: unknown): 'standard' | 'off' | 'custom' {
  return value === 'off' || value === 'custom' ? value : 'standard';
}

function normalizeClassification(value: unknown): DaemonServerWorkErrorClassification | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  if (!kind) return null;
  const retryable = value.retryable;
  if (typeof retryable !== 'boolean') return null;
  return {
    kind,
    retryable,
    ...(typeof value.statusCode === 'number' ? { statusCode: Math.trunc(value.statusCode) } : {}),
    ...(typeof value.retryAfterMs === 'number' ? { retryAfterMs: Math.max(0, Math.trunc(value.retryAfterMs)) } : {}),
  } as DaemonServerWorkErrorClassification;
}

function normalizeRuntimeClassification(value: unknown): ConnectedServiceRuntimeFailureClassification | null {
  return sanitizeConnectedServiceRuntimeFailureClassification(value);
}

function normalizeIntent(value: unknown): RuntimeAuthRecoveryIntent | null {
  if (!isRecord(value)) return null;
  if (value.v !== 1 && value.v !== 2) return null;
  if (
    value.status !== 'waiting'
    && value.status !== 'checking'
    && value.status !== 'resumed_awaiting_proof'
    && value.status !== 'cancelled'
    && value.status !== 'exhausted'
    && value.status !== 'recovered'
  ) return null;
  const sessionId = readString(value.sessionId);
  const serviceId = readString(value.serviceId);
  const classification = normalizeRuntimeClassification(value.classification);
  const armedAtMs = readNonNegativeNumber(value.armedAtMs);
  const attemptCount = readNonNegativeNumber(value.attemptCount);
  const maxAttempts = readNonNegativeNumber(value.maxAttempts);
  const switchesThisTurn = readNonNegativeNumber(value.switchesThisTurn);
  const nextRetryAtMs = value.nextRetryAtMs === null ? null : readNonNegativeNumber(value.nextRetryAtMs);
  if (
    !sessionId
    || !serviceId
    || !classification
    || armedAtMs === null
    || attemptCount === null
    || maxAttempts === null
    || switchesThisTurn === null
    || nextRetryAtMs === undefined
  ) return null;
  const failurePhase = value.failurePhase === 'apply' ? 'apply' : 'handler';
  const lastSettledTransition = value.lastSettledTransition === 'working'
    || value.lastSettledTransition === 'scheduled'
    || value.lastSettledTransition === 'terminal'
    || value.lastSettledTransition === 'recovered'
    ? value.lastSettledTransition
    : undefined;
  const pendingVisibleEvents = Array.isArray(value.pendingVisibleEvents)
    ? value.pendingVisibleEvents.flatMap((candidate): RuntimeAuthRecoveryPendingVisibleEvent[] => {
        if (!isRecord(candidate)) return [];
        const attemptId = readString(candidate.attemptId);
        const transition = candidate.transition === 'working'
          || candidate.transition === 'scheduled'
          || candidate.transition === 'terminal'
          || candidate.transition === 'recovered'
          ? candidate.transition
          : null;
        const parsedEvent = TranscriptRawAgentEventV1Schema.safeParse(candidate.transcriptEvent);
        if (!attemptId || !transition || !parsedEvent.success || parsedEvent.data.type !== 'connected-service-runtime-auth-recovery') {
          return [];
        }
        return [{ attemptId, transition, transcriptEvent: parsedEvent.data }];
      })
    : [];
  return {
    v: value.v,
    ...(readString(value.attemptId) ? { attemptId: readString(value.attemptId) as string } : {}),
    ...(lastSettledTransition ? { lastSettledTransition } : {}),
    ...(pendingVisibleEvents.length > 0 ? { pendingVisibleEvents } : {}),
    sessionId,
    serviceId,
    profileId: readString(value.profileId),
    groupId: readString(value.groupId),
    resumePromptMode: readResumePromptMode(value.resumePromptMode),
    status: value.status,
    armedAtMs,
    nextRetryAtMs,
    attemptCount,
    maxAttempts,
    ...(readNonNegativeNumber(value.degradedAttemptCount) === null
      ? {}
      : { degradedAttemptCount: readNonNegativeNumber(value.degradedAttemptCount) as number }),
    ...(readNonNegativeNumber(value.coalescedReplayCount) === null
      ? {}
      : { coalescedReplayCount: readNonNegativeNumber(value.coalescedReplayCount) as number }),
    switchesThisTurn,
    classification,
    failurePhase,
    failureReason: readString(value.failureReason) ?? 'unknown',
    lastError: readString(value.lastError),
    lastErrorClassification: normalizeClassification(value.lastErrorClassification),
    pendingTargetProfileId: value.pendingTargetProfileId === undefined || value.pendingTargetProfileId === null
      ? null
      : readString(value.pendingTargetProfileId),
    pendingTargetGeneration: value.pendingTargetGeneration === undefined || value.pendingTargetGeneration === null
      ? null
      : readNonNegativeNumber(value.pendingTargetGeneration),
    terminalAtMs: value.terminalAtMs === undefined || value.terminalAtMs === null
      ? null
      : readNonNegativeNumber(value.terminalAtMs),
    terminalReason: value.terminalReason === undefined || value.terminalReason === null
      ? null
      : readString(value.terminalReason),
  };
}

function buildTerminalRuntimeAuthIntent(input: Readonly<{
  intent: RuntimeAuthRecoveryIntent;
  nowMs: number;
  terminalReason: string | null;
}>): RuntimeAuthRecoveryIntent {
  const transcriptEvent = buildRuntimeAuthRecoveryTerminalTranscriptEvent(
    input.intent,
    input.terminalReason ?? 'terminal_recovery_result',
  );
  return {
    ...input.intent,
    v: 2,
    status: 'cancelled',
    lastSettledTransition: 'terminal',
    nextRetryAtMs: null,
    terminalAtMs: input.nowMs,
    terminalReason: input.terminalReason,
    ...(input.intent.attemptId && transcriptEvent ? {
      pendingVisibleEvents: mergeRuntimeAuthRecoveryPendingVisibleEvents(
        input.intent.pendingVisibleEvents,
        [{ attemptId: input.intent.attemptId, transition: 'terminal', transcriptEvent }],
      ),
    } : {}),
  };
}

function withRuntimeAuthWaitPresentation(intent: RuntimeAuthRecoveryIntent): RuntimeAuthRecoveryIntent {
  if (!intent.attemptId) return intent;
  const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
    status: 'retry_scheduled',
    classification: intent.classification,
    uxDiagnostic: buildRuntimeAuthRecoveryScheduledUxDiagnostic({
      classification: intent.classification,
      nextRetryAtMs: intent.nextRetryAtMs,
      reason: intent.lastError,
    }),
    nextRetryAtMs: intent.nextRetryAtMs,
    attempt: intent.attemptCount,
    terminal: false,
    reason: intent.lastError ?? 'awaiting_limit_reset',
  });
  if (!transcriptEvent) return intent;
  return {
    ...intent,
    lastSettledTransition: 'scheduled',
    pendingVisibleEvents: mergeRuntimeAuthRecoveryPendingVisibleEvents(intent.pendingVisibleEvents, [
      { attemptId: intent.attemptId, transition: 'scheduled', transcriptEvent },
    ]),
  };
}

function buildRuntimeAuthRecoveryTerminalTranscriptEvent(
  intent: RuntimeAuthRecoveryIntent,
  reason: string,
): ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1 | null {
  return buildRuntimeAuthRecoveryTranscriptEvent({
    status: 'cancelled',
    classification: intent.classification,
    attempt: intent.attemptCount,
    terminal: true,
    reason,
  });
}

function buildRecoveredRuntimeAuthIntent(
  intent: RuntimeAuthRecoveryIntent,
  nowMs: number,
): RuntimeAuthRecoveryIntent {
  return {
    ...intent,
    v: 2,
    status: 'recovered',
    nextRetryAtMs: null,
    lastSettledTransition: 'recovered',
    terminalAtMs: nowMs,
    terminalReason: 'provider_outcome_recovered',
  };
}

function readSwitchAttemptResult(result: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(result)) return null;
  if (result.status === 'switch_attempted' && isRecord(result.result)) return result.result;
  return result;
}

// Non-terminal degraded lifecycle outcomes from a recovery handler. Neither is a
// success and neither is terminal: the recovery must stay WAITING and be re-driven
// when the daemon/endpoint is healthy again.
//   - daemon_lifecycle_unavailable: the daemon is shutting down / control server is
//     stopping. The handler early-returned WITHOUT running switch/restart/continuation.
//     Treated as a deferral (the gate already avoids counting it as an attempt).
//   - session_endpoint_unavailable: the session control endpoint was unreachable
//     (ECONNREFUSED / socket hang up) during a recovery fetch — a transient outage.
function isDegradedLifecycleRecoveryResult(result: unknown): boolean {
  if (!isRecord(result)) return false;
  return result.status === 'daemon_lifecycle_unavailable'
    || result.status === 'session_endpoint_unavailable';
}

function resolveDegradedReason(result: unknown): string {
  return isRecord(result) && result.status === 'daemon_lifecycle_unavailable'
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
    const terminalReason = 'degraded_recovery_attempts_exhausted';
    return {
      status: 'terminal',
      lastError: terminalReason,
      intent: buildTerminalRuntimeAuthIntent({
        intent: {
          ...input.intent,
          attemptCount: preTickAttemptCount,
          degradedAttemptCount,
          lastError: terminalReason,
        },
        nowMs: input.nowMs,
        terminalReason,
      }),
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

function readApplyFailure(result: unknown): Readonly<{
  errorCode: string;
  diagnostics: Readonly<Record<string, unknown>> | null;
}> | null {
  const switchResult = readSwitchAttemptResult(result);
  if (!switchResult || switchResult.status !== 'generation_apply_failed') return null;
  const errorCode = readString(switchResult.errorCode);
  if (!errorCode) return null;
  return {
    errorCode,
    diagnostics: isRecord(switchResult.diagnostics) ? switchResult.diagnostics : null,
  };
}

function isDurableContinuityReconstructionExhausted(
  diagnostics: Readonly<Record<string, unknown>> | null,
): boolean {
  if (!diagnostics) return false;
  if (diagnostics.durableContinuityReconstructionExhausted === true) return true;
  const candidates = [
    diagnostics.durableContinuity,
    diagnostics.durableContinuityReconstruction,
    diagnostics.continuity,
  ];
  return candidates.some((candidate) => {
    if (!isRecord(candidate)) return false;
    const status = readString(candidate.status)
      ?? readString(candidate.reconstructionStatus)
      ?? readString(candidate.reconstructionState);
    return candidate.reconstructionExhausted === true
      || candidate.durableReconstructionExhausted === true
      || status === 'exhausted'
      || status === 'terminal';
  });
}

function classifyApplyFailure(result: unknown): RetryDecision | null {
  const failure = readApplyFailure(result);
  if (!failure) return null;
  if (
    failure.errorCode === 'provider_account_adoption_mismatch'
    || failure.errorCode === 'post_switch_verification_failed'
  ) {
    const verification = isRecord(failure.diagnostics?.verification)
      ? failure.diagnostics.verification
      : null;
    const explicit = normalizeClassification(verification?.errorClassification)
      ?? normalizeClassification(failure.diagnostics?.errorClassification);
    const retryable = failure.diagnostics?.retryable === true || explicit?.retryable === true;
    if (retryable) {
      return {
        retryable: true,
        classification: explicit ?? { kind: 'protocol_error', retryable: true },
        failurePhase: 'apply',
        failureReason: failure.errorCode,
        lastError: readString(verification?.reason) ?? failure.errorCode,
      };
    }
    return {
      retryable: false,
      classification: explicit,
      reason: 'non_retryable_apply_failure',
      failurePhase: 'apply',
      lastError: readString(verification?.reason) ?? failure.errorCode,
    };
  }
  // Incident Jun-11 H-A: a continuity resolution against a MISSING account-settings snapshot
  // (freshly restarted daemon, no spawn/settings hint yet) is an infrastructure gap, not a
  // provider verdict. It must wait-and-retry — the snapshot bootstraps within seconds — never
  // terminalize as non_retryable_apply_failure while state sharing is in fact enabled.
  if (failure.errorCode === 'provider_state_sharing_settings_unavailable') {
    const explicit = normalizeClassification(failure.diagnostics?.errorClassification);
    return {
      retryable: true,
      classification: explicit ?? { kind: 'dependency_unavailable', retryable: true },
      failurePhase: 'apply',
      failureReason: 'account_settings_unavailable',
      lastError: failure.errorCode,
    };
  }
  // Missing provider resume state during recovery is a durable-continuity infrastructure gap until
  // the reconstruction path has explicitly exhausted. Keep arbitrary provider verdicts fail-closed.
  if (failure.errorCode === 'provider_session_state_unavailable_for_resume') {
    const explicit = normalizeClassification(failure.diagnostics?.errorClassification);
    if (
      failure.diagnostics?.retryable === false
      || explicit?.retryable === false
      || isDurableContinuityReconstructionExhausted(failure.diagnostics)
    ) {
      return {
        retryable: false,
        classification: explicit,
        reason: 'provider_session_state_unavailable_after_reconstruction',
        failurePhase: 'apply',
        lastError: failure.errorCode,
      };
    }
    return {
      retryable: true,
      classification: explicit ?? { kind: 'dependency_unavailable', retryable: true },
      failurePhase: 'apply',
      failureReason: 'durable_continuity_reconstruction_retrying',
      lastError: failure.errorCode,
    };
  }
  if (
    failure.errorCode === 'restart_failed'
    && failure.diagnostics?.failurePhase === 'restart'
    && failure.diagnostics.retryable === true
  ) {
    const explicit = normalizeClassification(failure.diagnostics?.errorClassification);
    return {
      retryable: true,
      classification: explicit ?? { kind: 'protocol_error', retryable: true },
      failurePhase: 'apply',
      failureReason: 'restart_failed',
      lastError: 'restart_failed',
    };
  }
  if (failure.errorCode !== 'hot_apply_failed') {
    return {
      retryable: false,
      classification: null,
      reason: 'non_retryable_apply_failure',
      failurePhase: 'apply',
      lastError: failure.errorCode,
    };
  }

  const explicit = normalizeClassification(failure.diagnostics?.underlyingErrorClassification);
  const underlyingError = readString(failure.diagnostics?.underlyingError);
  const sanitizedUnderlyingError = underlyingError
    ? sanitizeConnectedServiceDiagnosticString(underlyingError)
    : null;
  const classification = explicit ?? (underlyingError ? classifyDaemonServerWorkError(new Error(underlyingError)) : null);
  if (classification?.retryable) {
    return {
      retryable: true,
      classification,
      failurePhase: 'apply',
      failureReason: 'hot_apply_failed',
      lastError: sanitizedUnderlyingError ?? failure.errorCode,
    };
  }
  return {
    retryable: false,
    classification,
    reason: 'non_retryable_apply_failure',
    failurePhase: 'apply',
    lastError: sanitizedUnderlyingError ?? failure.errorCode,
  };
}

// Provider-outcome proof gate. A switch event, auth-store adoption, credential
// refresh, or restart request is a recovery PHASE, not proof the provider can
// authenticate. Recovery is only cleared as recovered when there is
// provider-qualified recovered proof. A genuinely fresh
// candidate is still useful intermediate evidence, but it is not yet provider
// acceptance. Local-only completions (credential_refreshed, generic ok:true,
// unverified switch / observed_generation) are NOT success — see
// resolveRuntimeAuthRecoveryOutcome.
function isRuntimeAuthRecoverySuccess(result: unknown): boolean {
  return isProvenRuntimeAuthRecoverySuccess(result);
}

// A local recovery step completed (a switch was applied / a credential was
// refreshed / a generation was observed / a generic ok was returned) but carries
// no deterministic provider-outcome proof. This is NOT terminal: the recovery must
// stay pending under the scheduler backoff/exhaustion lifecycle rather than being
// fabricated into "recovered" (the live Codex/Pi/Claude loop bug). WAVE-2 SEAM:
// bounded provider-activity proof will be the deterministic terminator here; until
// then unproven completions wait and eventually exhaust rather than wait forever.
function isLocallyCompleteWithoutProof(result: unknown): boolean {
  const proof = resolveRuntimeAuthRecoveryProof(result);
  if (proof !== null && proof !== 'fresh_candidate_selected') return false;
  const switchResult = readSwitchAttemptResult(result);
  if (!switchResult) return false;
  return proof === 'fresh_candidate_selected'
    || switchResult.status === 'switched'
    || switchResult.status === 'observed_generation'
    || switchResult.status === 'credential_refreshed'
    || switchResult.ok === true;
}

function isRuntimeAuthRecoveryTerminal(result: unknown): boolean {
  return resolveRuntimeAuthRecoveryTerminalReason(result) !== null;
}

function resolveRuntimeAuthRecoveryTerminalReason(result: unknown): string | null {
  const proof = resolveRuntimeAuthRecoveryProof(result);
  if (isTerminalProviderOutcomeProof(proof)) return proof;
  const switchResult = readSwitchAttemptResult(result);
  if (!switchResult) return 'terminal_recovery_result';
  const status = readString(switchResult.status);
  if (!status || status === 'generation_apply_failed') return null;
  // A1-MED-1: a temporary-throttle handoff is never terminal for THIS scheduler — ownership
  // moved (or failed to move) to the TemporaryThrottleRecoveryScheduler; terminalizing it
  // persisted an unclearable `cancelled` record that blocked the key for 7 days.
  if (readTemporaryRetryHandoffStatus(switchResult) !== null) return null;
  return status;
}

// `temporary_retry_armed`: the TemporaryThrottleRecoveryScheduler now owns this failure.
// `temporary_retry_unavailable`: the failure is a transient capacity class that could not arm a
// temporary retry (no session id / no scheduler) — never a durable-auth terminal state either.
function readTemporaryRetryHandoffStatus(result: Readonly<Record<string, unknown>>): string | null {
  const status = readString(result.status);
  if (status === 'temporary_retry_armed' || status === 'temporary_retry_unavailable') return status;
  return null;
}

const DEFAULT_RUNTIME_AUTH_RECOVERY_BASE_BACKOFF_MS = 1_000;
const DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_BACKOFF_MS = 60_000;
function resolveRuntimeAuthRecoveryDisposition(input: Readonly<{
  result: unknown;
  intent: RuntimeAuthRecoveryIntent;
  unknownNoEligibleMemberBackoffMs: number;
  nowMs: number;
}>) {
  return resolveRuntimeAuthRecoveryResultDisposition({
    result: input.result,
    classificationFailureKind: input.intent.classification.kind,
    classificationResetsAtMs: input.intent.classification.resetsAtMs ?? null,
    additionalWaitCandidatesMs: [input.intent.nextRetryAtMs],
    unknownNoEligibleMemberBackoffMs: input.unknownNoEligibleMemberBackoffMs,
    nowMs: input.nowMs,
  });
}

function classifyHandlerError(error: unknown): RetryDecision {
  const applyFailure = readConnectedServiceAuthGenerationApplyFailure(error);
  if (applyFailure) {
    return classifyApplyFailure({
      status: 'generation_apply_failed',
      errorCode: applyFailure.errorCode,
      ...(applyFailure.diagnostics === undefined ? {} : { diagnostics: applyFailure.diagnostics }),
    }) ?? {
      retryable: false,
      classification: null,
      reason: 'non_retryable_apply_failure',
      failurePhase: 'apply',
      lastError: applyFailure.errorCode,
    };
  }
  const classification = classifyDaemonServerWorkError(error);
  const message = sanitizeConnectedServiceDiagnosticString(error instanceof Error ? error.message : String(error));
  if (classification.retryable) {
    // A transient local-endpoint outage (ECONNREFUSED / socket hang up / reset / timeout)
    // during a recovery fetch is the `session_endpoint_unavailable` edge: the session control
    // endpoint was unreachable. Surface a stable reason for diagnostics; it stays retryable/waiting.
    const failureReason = (classification.kind === 'network' || classification.kind === 'timeout')
      ? 'session_endpoint_unavailable'
      : 'handler_transient_failure';
    return {
      retryable: true,
      classification,
      failurePhase: 'handler',
      failureReason,
      lastError: message,
    };
  }
  return {
    retryable: false,
    classification,
    reason: 'non_retryable_handler_failure',
    failurePhase: 'handler',
    lastError: message,
  };
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

function buildClassifiedFailureIntakeDecision(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  nowMs: number;
}>): RetryDecision {
  const retryAfterMs = resolveClassifiedFailureRetryAfterMs(input);
  return {
    retryable: true,
    classification: {
      kind: mapRuntimeFailureKindToDaemonWorkErrorKind(input.classification.kind),
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
    failurePhase: 'handler',
    failureReason: 'classified_failure_reported',
    lastError: input.classification.kind,
  };
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

function normalizeMaxAttempts(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS;
  return Math.max(1, Math.trunc(value));
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

function computeRuntimeAuthRecoveryBackoffMs(input: Readonly<{
  attemptCount: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitterMs: () => number;
}>): number {
  const exponential = input.baseBackoffMs * (2 ** Math.max(0, input.attemptCount));
  const jitter = Math.max(0, Math.trunc(input.jitterMs()));
  return Math.min(input.maxBackoffMs, exponential) + jitter;
}

function buildRecoveryKeyForIntent(
  intent: Pick<RuntimeAuthRecoveryIntent, 'sessionId' | 'serviceId' | 'profileId' | 'groupId'>,
): string {
  return buildRuntimeAuthRecoveryKey({
    sessionId: intent.sessionId,
    serviceId: intent.serviceId,
    profileId: intent.profileId,
    groupId: intent.groupId,
  });
}

function isTerminalRuntimeAuthRecoveryStatus(status: RuntimeAuthRecoveryIntentStatus): boolean {
  return status === 'cancelled' || status === 'exhausted' || status === 'recovered';
}

function isPendingRuntimeAuthRecoveryStatus(status: RuntimeAuthRecoveryIntentStatus): boolean {
  return status === 'waiting'
    || status === 'checking'
    || status === 'resumed_awaiting_proof';
}

function isWaitingRuntimeAuthRecoveryStatus(status: RuntimeAuthRecoveryIntentStatus): boolean {
  return status === 'waiting' || status === 'resumed_awaiting_proof';
}

function mergeRuntimeAuthNextRetryAtMs(
  previous: RuntimeAuthRecoveryIntent,
  next: RuntimeAuthRecoveryIntent,
): number | null {
  if (isTerminalRuntimeAuthRecoveryStatus(previous.status)) return previous.nextRetryAtMs;
  if (previous.nextRetryAtMs === null) return next.nextRetryAtMs;
  if (next.nextRetryAtMs === null) return previous.nextRetryAtMs;
  return Math.min(previous.nextRetryAtMs, next.nextRetryAtMs);
}

const runtimeAuthRecoveryTransitionRank: Readonly<Record<RuntimeAuthRecoveryTransition, number>> = {
  working: 0,
  scheduled: 1,
  terminal: 2,
  recovered: 3,
};

function mergeRuntimeAuthRecoveryTransition(
  previous: RuntimeAuthRecoveryTransition | undefined,
  next: RuntimeAuthRecoveryTransition | undefined,
): RuntimeAuthRecoveryTransition | undefined {
  if (!previous) return next;
  if (!next) return previous;
  return runtimeAuthRecoveryTransitionRank[previous] >= runtimeAuthRecoveryTransitionRank[next]
    ? previous
    : next;
}

function doesRuntimeAuthRecoveryTransitionAdvance(
  previous: RuntimeAuthRecoveryTransition | undefined,
  next: RuntimeAuthRecoveryTransition,
): boolean {
  return previous === undefined
    || runtimeAuthRecoveryTransitionRank[next] > runtimeAuthRecoveryTransitionRank[previous];
}

function buildRuntimeAuthRecoveryAttemptId(reportId: string | undefined): string {
  const opaqueSource = typeof reportId === 'string' && reportId.trim().length > 0
    ? reportId.trim()
    : randomUUID();
  const digest = createHash('sha256').update(opaqueSource).digest('base64url');
  return `runtime-auth-attempt:${digest}`;
}

function mergeRuntimeAuthRecoveryIntent(
  previous: RuntimeAuthRecoveryIntent | null,
  next: RuntimeAuthRecoveryIntent,
): RuntimeAuthRecoveryIntent {
  if (!previous) return next;
  if (previous.status === 'recovered') {
    if (previous.attemptId === next.attemptId) return previous;
    // Recovery closes only the settled attempt. Any later failure owns a new epoch, including
    // handler intake whose producer does not have a durable provider report id.
    return next;
  }
  if (previous.status === 'cancelled' || previous.status === 'exhausted') {
    if (previous.attemptId === next.attemptId) return previous;
    // Only a fresh in-band provider report owns a new recovery epoch. A later handler/apply
    // failure without the original attempt id is still fallout from the settled attempt and must
    // not revive it merely because its caller omitted the report id.
    return next.lastSettledTransition === 'working' ? next : previous;
  }
  const sameEvidence = hasSameRuntimeAuthRecoveryEvidence(previous, next);
  const previousSourceKey = previous.classification.sourceKey;
  const nextSourceKey = next.classification.sourceKey;
  const hasExplicitNewEvidenceEpoch = typeof previousSourceKey === 'string'
    && previousSourceKey.length > 0
    && typeof nextSourceKey === 'string'
    && nextSourceKey.length > 0
    && previousSourceKey !== nextSourceKey;
  if (!sameEvidence && hasExplicitNewEvidenceEpoch) return next;
  if (!sameEvidence && previous.status !== 'checking' && previous.status !== 'resumed_awaiting_proof') return next;
  return {
    ...next,
    v: 2,
    attemptId: previous.attemptId ?? next.attemptId,
    // This merge branch retains the previous attempt identity. Its resolved
    // prompt mode is an attempt fact too, so duplicate evidence cannot rewrite
    // the policy that the in-band handler and future wakes must share.
    resumePromptMode: previous.resumePromptMode,
    lastSettledTransition: mergeRuntimeAuthRecoveryTransition(
      previous.lastSettledTransition,
      next.lastSettledTransition,
    ),
    pendingVisibleEvents: mergeRuntimeAuthRecoveryPendingVisibleEvents(
      previous.pendingVisibleEvents,
      next.pendingVisibleEvents,
    ),
    status: previous.status,
    nextRetryAtMs: sameEvidence
      ? previous.nextRetryAtMs ?? next.nextRetryAtMs
      : mergeRuntimeAuthNextRetryAtMs(previous, next),
    attemptCount: previous.attemptCount,
    maxAttempts: Math.min(previous.maxAttempts, next.maxAttempts),
    terminalAtMs: isTerminalRuntimeAuthRecoveryStatus(previous.status)
      ? previous.terminalAtMs ?? null
      : next.terminalAtMs ?? null,
    terminalReason: isTerminalRuntimeAuthRecoveryStatus(previous.status)
      ? previous.terminalReason ?? null
      : next.terminalReason ?? null,
    pendingTargetProfileId: next.pendingTargetProfileId ?? previous.pendingTargetProfileId ?? null,
    pendingTargetGeneration: next.pendingTargetGeneration ?? previous.pendingTargetGeneration ?? null,
  };
}

function mergeRuntimeAuthRecoveryPendingVisibleEvents(
  previous: ReadonlyArray<RuntimeAuthRecoveryPendingVisibleEvent> | undefined,
  next: ReadonlyArray<RuntimeAuthRecoveryPendingVisibleEvent> | undefined,
): ReadonlyArray<RuntimeAuthRecoveryPendingVisibleEvent> | undefined {
  const merged = new Map<string, RuntimeAuthRecoveryPendingVisibleEvent>();
  for (const delivery of [...(previous ?? []), ...(next ?? [])]) {
    merged.set(`${delivery.attemptId}\u0000${delivery.transition}`, delivery);
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function isSameServerWorkErrorClassification(
  left: DaemonServerWorkErrorClassification | null,
  right: DaemonServerWorkErrorClassification | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.kind === right.kind
    && left.retryable === right.retryable
    && left.statusCode === right.statusCode
    && left.retryAfterMs === right.retryAfterMs;
}

function isSameRuntimeFailureClassification(
  left: ConnectedServiceRuntimeFailureClassification,
  right: ConnectedServiceRuntimeFailureClassification,
): boolean {
  return left.kind === right.kind
    && left.serviceId === right.serviceId
    && left.profileId === right.profileId
    && left.groupId === right.groupId
    && left.groupGeneration === right.groupGeneration
    && left.credentialRevision === right.credentialRevision
    && left.activeProfileId === right.activeProfileId
    && left.resetsAtMs === right.resetsAtMs
    && left.retryAfterMs === right.retryAfterMs
    && left.limitCategory === right.limitCategory
    && left.quotaScope === right.quotaScope
    && left.providerLimitId === right.providerLimitId
    && left.credentialHealthStatus === right.credentialHealthStatus
    && left.identityProofVersion === right.identityProofVersion
    && left.sourceKey === right.sourceKey
    && left.providerAccountUsageRecordId === right.providerAccountUsageRecordId
    && left.sourceProviderAccountId === right.sourceProviderAccountId
    && left.failingAccessTokenFingerprint === right.failingAccessTokenFingerprint
    && left.planType === right.planType
    && left.source === right.source;
}

function hasSameRuntimeAuthRecoveryEvidence(
  left: RuntimeAuthRecoveryIntent,
  right: RuntimeAuthRecoveryIntent,
): boolean {
  return isSameRuntimeFailureClassification(left.classification, right.classification);
}

function hasSameRuntimeAuthFailureFields(
  left: RuntimeAuthRecoveryIntent,
  right: RuntimeAuthRecoveryIntent,
): boolean {
  return left.switchesThisTurn === right.switchesThisTurn
    && left.failurePhase === right.failurePhase
    && left.failureReason === right.failureReason
    && left.lastError === right.lastError
    && isSameServerWorkErrorClassification(left.lastErrorClassification, right.lastErrorClassification)
    && isSameRuntimeFailureClassification(left.classification, right.classification);
}

function hasSameRuntimeAuthRecoverySettlementEpoch(
  current: RuntimeAuthRecoveryIntent,
  observed: RuntimeAuthRecoveryIntent,
): boolean {
  if (current.attemptId !== undefined || observed.attemptId !== undefined) {
    return current.attemptId !== undefined && current.attemptId === observed.attemptId;
  }
  return current.armedAtMs === observed.armedAtMs
    && current.attemptCount === observed.attemptCount
    && hasSameRuntimeAuthFailureFields(current, observed);
}

function mergeRuntimeAuthWakeNextRetryAtMs(
  current: RuntimeAuthRecoveryIntent,
  next: RuntimeAuthRecoveryIntent,
): number | null {
  if (!isWaitingRuntimeAuthRecoveryStatus(next.status)) return next.nextRetryAtMs;
  if (current.nextRetryAtMs === null) return next.nextRetryAtMs;
  if (next.nextRetryAtMs === null) return current.nextRetryAtMs;
  return Math.min(current.nextRetryAtMs, next.nextRetryAtMs);
}

function mergeRuntimeAuthRecoveryWakeWrite(input: Readonly<{
  current: RuntimeAuthRecoveryIntent | null;
  base: RuntimeAuthRecoveryIntent;
  next: RuntimeAuthRecoveryIntent;
  reason: string;
}>): RuntimeAuthRecoveryIntent {
  if (!input.current) return input.next;
  if (isTerminalRuntimeAuthRecoveryStatus(input.current.status)) return input.current;
  if (input.reason === 'success') {
    return hasSameRuntimeAuthFailureFields(input.current, input.base)
      ? input.next
      : input.current;
  }
  if (hasSameRuntimeAuthFailureFields(input.current, input.base)) return input.next;
  const keepLatestFailureMessage = input.reason === 'waiting' || input.reason === 'delayed';
  return {
    ...input.next,
    switchesThisTurn: input.current.switchesThisTurn,
    classification: input.current.classification,
    failurePhase: input.current.failurePhase,
    failureReason: input.current.failureReason,
    lastError: keepLatestFailureMessage ? input.current.lastError : input.next.lastError,
    lastErrorClassification: input.current.lastErrorClassification,
    attemptCount: Math.max(input.current.attemptCount, input.next.attemptCount),
    maxAttempts: Math.min(input.current.maxAttempts, input.next.maxAttempts),
    nextRetryAtMs: mergeRuntimeAuthWakeNextRetryAtMs(input.current, input.next),
    pendingTargetProfileId: input.next.pendingTargetProfileId ?? input.current.pendingTargetProfileId ?? null,
    pendingTargetGeneration: input.next.pendingTargetGeneration ?? input.current.pendingTargetGeneration ?? null,
  };
}

function isRuntimeAuthDurableWaitIntent(intent: RuntimeAuthRecoveryIntent): boolean {
  return intent.lastError === 'no_eligible_member'
    || intent.lastError === 'switch_limit_reached'
    || intent.lastError === 'awaiting_limit_reset';
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
  // bounded by the coalesced-replay budget (RD-REC-15 / F4).
  const currentTargetProfileId = input.pendingTarget?.activeProfileId ?? null;
  if (!currentTargetProfileId) return false;
  if (input.intent.pendingTargetProfileId !== currentTargetProfileId) return false;
  const failingProfileId = input.intent.classification.profileId;
  return Boolean(failingProfileId && failingProfileId !== currentTargetProfileId);
}

function isUntargetedProviderOutcomeProofWaitRefresh(input: Readonly<{
  intent: RuntimeAuthRecoveryIntent;
  pendingTarget: RuntimeAuthPendingProofTarget | null;
}>): boolean {
  return input.intent.lastError === RUNTIME_AUTH_RECOVERY_UNPROVEN_PROVIDER_OUTCOME_ERROR
    && input.pendingTarget === null
    && input.intent.pendingTargetProfileId === null
    && input.intent.pendingTargetGeneration === null;
}

// Handler verdict: the replayed recovery no longer applies (e.g. the group already moved
// off the failing profile). The scheduler removes the durable record so the same key can
// re-arm on a genuine future failure — see `DurableRecoveryOutcome['superseded']`.
function readRuntimeAuthRecoverySupersededReason(result: unknown): string | null {
  const switchResult = readSwitchAttemptResult(result);
  if (!switchResult || switchResult.status !== 'recovery_superseded') return null;
  return readString(switchResult.reason) ?? 'recovery_superseded';
}

export class RuntimeAuthRecoveryScheduler {
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly maxDegradedAttempts: number;
  private readonly degradedBackoffMs: number;
  private readonly maxCoalescedReplays: number;
  private readonly providerOutcomePendingWaitMs: number | null;
  private readonly scheduler: DurableBackoffRecoveryScheduler<RuntimeAuthRecoveryIntent>;
  private pendingVisibleEventDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingVisibleEventDrainInFlight = false;
  private pendingVisibleEventDrainRequested = false;
  private pendingVisibleEventDeliver: ((delivery: RuntimeAuthRecoveryVisibleEventDelivery) => Promise<void>) | null = null;
  private pendingVisibleEventRetryDelayMs = 10_000;
  private pendingVisibleEventDrainError: ((error: unknown) => void) | null = null;
  private pendingVisibleEventDrainDisposed = false;

  constructor(private readonly deps: RuntimeAuthRecoverySchedulerDeps) {
    this.baseBackoffMs = normalizePositiveInteger(deps.baseBackoffMs, DEFAULT_RUNTIME_AUTH_RECOVERY_BASE_BACKOFF_MS);
    this.maxBackoffMs = Math.max(
      this.baseBackoffMs,
      normalizePositiveInteger(deps.maxBackoffMs, DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_BACKOFF_MS),
    );
    this.maxAttempts = normalizeMaxAttempts(deps.maxAttempts);
    this.maxDegradedAttempts = typeof deps.maxDegradedAttempts === 'number'
      && Number.isFinite(deps.maxDegradedAttempts)
      && deps.maxDegradedAttempts > 0
      ? Math.trunc(deps.maxDegradedAttempts)
      : DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_DEGRADED_ATTEMPTS;
    this.degradedBackoffMs = typeof deps.degradedBackoffMs === 'number'
      && Number.isFinite(deps.degradedBackoffMs)
      && deps.degradedBackoffMs > 0
      ? Math.trunc(deps.degradedBackoffMs)
      : DEFAULT_RUNTIME_AUTH_RECOVERY_DEGRADED_BACKOFF_MS;
    this.maxCoalescedReplays = typeof deps.maxCoalescedReplays === 'number'
      && Number.isFinite(deps.maxCoalescedReplays)
      && deps.maxCoalescedReplays >= 0
      ? Math.trunc(deps.maxCoalescedReplays)
      : DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_COALESCED_REPLAYS;
    this.providerOutcomePendingWaitMs = typeof deps.providerOutcomePendingWaitMs === 'number'
      && Number.isFinite(deps.providerOutcomePendingWaitMs)
      && deps.providerOutcomePendingWaitMs > 0
      ? Math.trunc(deps.providerOutcomePendingWaitMs)
      : null;
    this.scheduler = new DurableBackoffRecoveryScheduler<RuntimeAuthRecoveryIntent>({
      nowMs: deps.nowMs,
      baseBackoffMs: deps.baseBackoffMs,
      maxBackoffMs: deps.maxBackoffMs,
      jitterMs: deps.jitterMs,
      store: deps.durableStore,
      normalizeIntent,
      getStatus: (intent) => intent.status === 'resumed_awaiting_proof'
        ? 'waiting'
        : intent.status === 'recovered'
          ? 'cancelled'
          : intent.status,
      getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => isRuntimeAuthDurableWaitIntent(intent)
        ? Number.MAX_SAFE_INTEGER
        : intent.maxAttempts,
      terminalRecordRetentionMs: DEFAULT_RUNTIME_AUTH_RECOVERY_TERMINAL_RECORD_RETENTION_MS,
      getTerminalPruneReferenceMs: (intent) => intent.terminalAtMs ?? intent.armedAtMs,
      markChecking: (intent, attemptCount) => ({
        ...intent,
        v: 2,
        status: 'checking',
        lastSettledTransition: mergeRuntimeAuthRecoveryTransition(intent.lastSettledTransition, 'working'),
        attemptCount,
      }),
      markWaiting: (intent, input) => withRuntimeAuthWaitPresentation({
        ...intent,
        v: 2,
        status: intent.status === 'resumed_awaiting_proof' ? 'resumed_awaiting_proof' : 'waiting',
        lastSettledTransition: mergeRuntimeAuthRecoveryTransition(intent.lastSettledTransition, 'scheduled'),
        nextRetryAtMs: input.nextRetryAtMs,
        lastError: input.lastError,
      }),
      markCancelled: (intent) => ({
        ...intent,
        v: 2,
        status: 'cancelled',
        lastSettledTransition: mergeRuntimeAuthRecoveryTransition(intent.lastSettledTransition, 'terminal'),
        nextRetryAtMs: null,
        lastError: null,
        terminalAtMs: deps.nowMs(),
        terminalReason: null,
      }),
      markExhausted: (intent, input) => {
        const uxDiagnostic = buildConnectedServiceUxDiagnostic({
          code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryDeadLettered,
          failurePhase: 'runtime_auth_recovery',
          source: 'runtime_auth_recovery',
          serviceId: intent.serviceId,
          profileId: intent.profileId,
          groupId: intent.groupId,
          retryable: true,
          diagnostics: {
            reason: input.lastError ?? 'max_attempts_exhausted',
            attemptCount: intent.attemptCount,
          },
        });
        const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
          status: 'dead_lettered',
          classification: intent.classification,
          uxDiagnostic,
          attempt: intent.attemptCount,
          terminal: true,
          reason: input.lastError ?? 'max_attempts_exhausted',
        });
        return {
          ...intent,
          v: 2,
          status: 'exhausted',
          lastSettledTransition: mergeRuntimeAuthRecoveryTransition(intent.lastSettledTransition, 'terminal'),
          nextRetryAtMs: null,
          lastError: input.lastError,
          terminalAtMs: deps.nowMs(),
          terminalReason: input.lastError,
          ...(intent.attemptId && transcriptEvent ? {
            pendingVisibleEvents: mergeRuntimeAuthRecoveryPendingVisibleEvents(
              intent.pendingVisibleEvents,
              [{ attemptId: intent.attemptId, transition: 'terminal', transcriptEvent }],
            ),
          } : {}),
        };
      },
      clearOnSuccess: true,
      getSessionId: (intent) => intent.sessionId,
      gate: deps.gate,
      mergeBeforeWakeWrite: ({ current, base, next, reason }) => mergeRuntimeAuthRecoveryWakeWrite({
        current,
        base,
        next,
        reason,
      }),
      recover: async (intent) => {
        try {
          const result = await deps.recover({
            sessionId: intent.sessionId,
            switchesThisTurn: intent.switchesThisTurn,
            classification: intent.classification,
            resumePromptMode: readResumePromptMode(intent.resumePromptMode),
            source: 'scheduler_retry',
          });
          if (isRuntimeAuthRecoverySuccess(result)) return { status: 'success' };
          const supersededReason = readRuntimeAuthRecoverySupersededReason(result);
          if (supersededReason) {
            return { status: 'superseded', reason: supersededReason };
          }
          // A1-MED-1: temporary-throttle handoff — remove this durable intent (the temporary
          // scheduler owns the wait now) so the key can re-arm on a genuine future failure.
          const switchResultForHandoff = readSwitchAttemptResult(result);
          const temporaryRetryHandoff = switchResultForHandoff
            ? readTemporaryRetryHandoffStatus(switchResultForHandoff)
            : null;
          if (temporaryRetryHandoff) {
            return { status: 'superseded', reason: temporaryRetryHandoff };
          }
          const applyDecision = classifyApplyFailure(result);
          if (applyDecision?.retryable) {
            return {
              status: 'wait',
              lastError: applyDecision.lastError,
              intent: {
                ...intent,
                lastErrorClassification: applyDecision.classification,
                lastError: applyDecision.lastError,
              },
            };
          }
          if (applyDecision && !applyDecision.retryable) {
            return {
              status: 'terminal',
              lastError: applyDecision.lastError,
              intent: buildTerminalRuntimeAuthIntent({
                intent: {
                  ...intent,
                  lastError: applyDecision.lastError,
                  lastErrorClassification: applyDecision.classification,
                },
                nowMs: deps.nowMs(),
                terminalReason: applyDecision.lastError,
              }),
            };
          }
          // A local recovery step completed but produced no deterministic
          // provider-outcome proof. Keep the recovery pending instead of clearing
          // it (success) or terminating it: the provider may still be broken, and
          // the scheduler's backoff/exhaustion lifecycle is the safe owner.
          if (isLocallyCompleteWithoutProof(result)) {
            const pendingTarget = readPendingProofTarget(result);
            const coalescedReplay = isStaleProfileReplayForPendingProofTarget({
              intent,
              pendingTarget,
            });
            // RD-REC-15 / F4: while a local repair is waiting for provider-outcome
            // proof, repeated local-only wakeups refresh the proof wait instead of
            // burning the dead-letter budget. Stale-profile replays are still
            // additionally bounded by maxCoalescedReplays when the target profile
            // keeps changing under the same durable recovery.
            const coalescedReplayCount = intent.coalescedReplayCount ?? 0;
            const rollbackAttempt = isUntargetedProviderOutcomeProofWaitRefresh({ intent, pendingTarget })
              || (coalescedReplay && coalescedReplayCount < this.maxCoalescedReplays);
            return {
              status: 'wait',
              lastError: RUNTIME_AUTH_RECOVERY_UNPROVEN_PROVIDER_OUTCOME_ERROR,
              intent: {
                ...intent,
                status: 'resumed_awaiting_proof',
                attemptCount: rollbackAttempt ? Math.max(0, intent.attemptCount - 1) : intent.attemptCount,
                ...(coalescedReplay ? { coalescedReplayCount: coalescedReplayCount + 1 } : {}),
                pendingTargetProfileId: pendingTarget?.activeProfileId ?? intent.pendingTargetProfileId ?? null,
                pendingTargetGeneration: pendingTarget?.generation ?? intent.pendingTargetGeneration ?? null,
              },
              ...(this.providerOutcomePendingWaitMs === null
                ? {}
                : { nextRetryAtMs: deps.nowMs() + this.providerOutcomePendingWaitMs }),
            };
          }
          // Degraded daemon-lifecycle / endpoint-unavailable outcomes are non-terminal: keep the
          // recovery waiting so a healthy daemon/endpoint re-drives it. Never terminalize a transient
          // shutdown/outage as a non-retryable recovery result. S2: these go on the bounded
          // degraded-retry track so a long local outage does not burn the normal attempt budget.
          if (isDegradedLifecycleRecoveryResult(result)) {
            return buildDegradedRecoveryOutcome({
              intent,
              reason: resolveDegradedReason(result),
              nowMs: deps.nowMs(),
              maxDegradedAttempts: this.maxDegradedAttempts,
              degradedBackoffMs: this.degradedBackoffMs,
            });
          }
          // Group-exhausted waits are durable provider-policy waits, never terminal.
          // Count the attempt for telemetry/backoff, but do not let the generic
          // max-attempt dead-letter rule override a known reset or backoff wait.
          const disposition = resolveRuntimeAuthRecoveryDisposition({
            result,
            intent,
            unknownNoEligibleMemberBackoffMs: computeRuntimeAuthRecoveryBackoffMs({
              attemptCount: intent.attemptCount,
              baseBackoffMs: this.baseBackoffMs,
              maxBackoffMs: this.maxBackoffMs,
              jitterMs: this.deps.jitterMs ?? (() => 0),
            }),
            nowMs: deps.nowMs(),
          });
          if (disposition?.kind === 'durable_wait') {
            return {
              status: 'wait',
              nextRetryAtMs: disposition.nextRetryAtMs,
              lastError: disposition.reason,
              exhaustOnMaxAttempt: false,
            };
          }
          if (disposition?.kind === 'terminal') {
            return {
              status: 'terminal',
              lastError: disposition.reason,
              intent: buildTerminalRuntimeAuthIntent({
                intent: {
                  ...intent,
                  lastError: disposition.reason,
                },
                nowMs: deps.nowMs(),
                terminalReason: disposition.reason,
              }),
            };
          }
          if (isRuntimeAuthRecoveryTerminal(result)) {
            const terminalReason = resolveRuntimeAuthRecoveryTerminalReason(result) ?? 'terminal_recovery_result';
            return {
              status: 'terminal',
              lastError: terminalReason,
              intent: buildTerminalRuntimeAuthIntent({
                intent: {
                  ...intent,
                  lastError: terminalReason,
                },
                nowMs: deps.nowMs(),
                terminalReason,
              }),
            };
          }
          return { status: 'wait', lastError: 'retryable_recovery_result' };
        } catch (error) {
          const decision = classifyHandlerError(error);
          if (!decision.retryable) {
            return {
              status: 'terminal',
              lastError: decision.lastError,
              intent: buildTerminalRuntimeAuthIntent({
                intent: {
                  ...intent,
                  lastError: decision.lastError,
                  lastErrorClassification: decision.classification,
                },
                nowMs: deps.nowMs(),
                terminalReason: decision.lastError,
              }),
            };
          }
          // S2: a connection-level endpoint outage thrown during the recovery fetch
          // (ECONNREFUSED / socket hang up / reset = `network`) is a degraded local condition, not a
          // provider failure. Route it onto the bounded degraded-retry track so a long local outage
          // cannot dead-letter the session before the normal attempt budget. A `timeout` is left on
          // the normal track: a slow-but-reachable endpoint can be a genuine recoverable failure.
          if (decision.retryable && decision.classification.kind === 'network') {
            return buildDegradedRecoveryOutcome({
              intent: {
                ...intent,
                lastError: decision.lastError,
                lastErrorClassification: decision.classification,
              },
              reason: 'session_endpoint_unavailable',
              nowMs: deps.nowMs(),
              maxDegradedAttempts: this.maxDegradedAttempts,
              degradedBackoffMs: this.degradedBackoffMs,
            });
          }
          return {
            status: 'wait',
            lastError: decision.lastError,
            intent: {
              ...intent,
              lastError: decision.lastError,
              lastErrorClassification: decision.classification,
            },
          };
        }
      },
      onRetry: ({ intent }) => {
        this.record({
          event: 'runtime_auth_recovery_retry',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
          attemptCount: intent.attemptCount,
          classification: intent.lastErrorClassification,
          failureKind: intent.classification.kind,
          attemptId: intent.attemptId,
          transition: 'working',
        });
      },
      onSuccess: ({ intent }) => {
        this.record({
          event: 'runtime_auth_recovery_success',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
          attemptId: intent.attemptId,
          transition: 'recovered',
        });
      },
      onTerminal: ({ intent, lastError }) => {
        const reason = lastError ?? 'terminal_recovery_result';
        const transcriptEvent = buildRuntimeAuthRecoveryTerminalTranscriptEvent(intent, reason);
        this.record({
          event: 'runtime_auth_recovery_terminal',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
          reason,
          attemptId: intent.attemptId,
          transition: 'terminal',
          ...(transcriptEvent ? { transcriptEvent } : {}),
        });
      },
      onSuperseded: ({ intent, reason }) => {
        this.record({
          event: 'runtime_auth_recovery_superseded',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
          reason: reason ?? 'recovery_superseded',
        });
      },
      onExhausted: ({ intent, lastError }) => {
        const uxDiagnostic = buildConnectedServiceUxDiagnostic({
          code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryDeadLettered,
          failurePhase: 'runtime_auth_recovery',
          source: 'runtime_auth_recovery',
          serviceId: intent.serviceId,
          profileId: intent.profileId,
          groupId: intent.groupId,
          retryable: true,
          diagnostics: {
            reason: lastError ?? 'max_attempts_exhausted',
            attemptCount: intent.attemptCount,
          },
        });
        const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
          status: 'dead_lettered',
          classification: intent.classification,
          uxDiagnostic,
          attempt: intent.attemptCount,
          terminal: true,
          reason: lastError ?? 'max_attempts_exhausted',
        });
        this.record({
          event: 'runtime_auth_recovery_dead_letter',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
          reason: lastError ?? 'max_attempts_exhausted',
          attemptCount: intent.attemptCount,
          failureKind: intent.classification.kind,
          uxDiagnostic,
          ...(transcriptEvent ? { transcriptEvent } : {}),
          attemptId: intent.attemptId,
          transition: 'terminal',
        });
      },
      onDelayed: ({ intent, retryAtMs, reason }) => {
        this.record({
          event: 'runtime_auth_recovery_delayed',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
          reason,
          nextRetryAtMs: retryAtMs,
          classification: intent.lastErrorClassification,
          failureKind: intent.classification.kind,
          transcriptEvent: intent.pendingVisibleEvents?.find((event) => event.transition === 'scheduled')?.transcriptEvent,
        });
      },
    });
  }

  read(sessionId: string): RuntimeAuthRecoveryIntent | null {
    const intents = this.readForSession(sessionId);
    return intents.find((intent) => isPendingRuntimeAuthRecoveryStatus(intent.status))
      ?? intents[0]
      ?? null;
  }

  readByKey(recoveryKey: string): RuntimeAuthRecoveryIntent | null {
    return this.scheduler.readByKey(recoveryKey);
  }

  readByKeyPassive(recoveryKey: string): RuntimeAuthRecoveryIntent | null {
    return this.scheduler.readByKeyPassive(recoveryKey);
  }

  /** Reconstructs persisted recovery state without timers or recovery effects. */
  hydratePassive(): ReadonlyArray<RuntimeAuthRecoveryIntent> {
    return this.scheduler.hydratePassive();
  }

  /** Delivers only already-authorized presentation events; it never arms recovery execution. */
  async drainPendingVisibleEvents(
    deliver: (delivery: RuntimeAuthRecoveryVisibleEventDelivery) => Promise<void>,
  ): Promise<number> {
    let delivered = 0;
    for (const intent of this.hydratePassive()) {
      const recoveryKey = buildRecoveryKeyForIntent(intent);
      for (const pending of intent.pendingVisibleEvents ?? []) {
        const current = this.readByKeyPassive(recoveryKey) ?? intent;
        await deliver({ sessionId: intent.sessionId, ...pending, recoveryIntent: current });
        await this.acknowledgePendingVisibleEvent({ recoveryKey, pending });
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
    if (this.pendingVisibleEventDrainDisposed) return;
    this.pendingVisibleEventDeliver = input.deliver;
    if (typeof input.retryDelayMs === 'number' && Number.isFinite(input.retryDelayMs)) {
      this.pendingVisibleEventRetryDelayMs = Math.max(0, Math.trunc(input.retryDelayMs));
    }
    if (input.onError) this.pendingVisibleEventDrainError = input.onError;
    this.pendingVisibleEventDrainRequested = true;
    if (this.pendingVisibleEventDrainTimer || this.pendingVisibleEventDrainInFlight) return;
    const delayMs = typeof input.delayMs === 'number' && Number.isFinite(input.delayMs)
      ? Math.max(0, Math.trunc(input.delayMs))
      : 2_000;
    this.pendingVisibleEventDrainTimer = setTimeout(() => {
      this.pendingVisibleEventDrainTimer = null;
      void this.runScheduledPendingVisibleEventDrain();
    }, delayMs);
    this.pendingVisibleEventDrainTimer.unref?.();
  }

  private async runScheduledPendingVisibleEventDrain(): Promise<void> {
    const deliver = this.pendingVisibleEventDeliver;
    if (!deliver || this.pendingVisibleEventDrainInFlight) return;
    this.pendingVisibleEventDrainInFlight = true;
    this.pendingVisibleEventDrainRequested = false;
    try {
      await this.drainPendingVisibleEvents(deliver);
    } catch (error) {
      if (!this.pendingVisibleEventDrainDisposed) this.pendingVisibleEventDrainRequested = true;
      this.pendingVisibleEventDrainError?.(error);
    } finally {
      this.pendingVisibleEventDrainInFlight = false;
    }
    if (!this.pendingVisibleEventDrainDisposed && this.pendingVisibleEventDrainRequested) {
      this.schedulePendingVisibleEventDrain({ deliver, delayMs: this.pendingVisibleEventRetryDelayMs });
    }
  }

  private async acknowledgePendingVisibleEvent(input: Readonly<{
    recoveryKey: string;
    pending: RuntimeAuthRecoveryPendingVisibleEvent;
  }>): Promise<void> {
    const keepOtherDeliveries = (intent: RuntimeAuthRecoveryIntent): RuntimeAuthRecoveryIntent => {
      const pendingVisibleEvents = intent.pendingVisibleEvents?.filter((candidate) => (
        candidate.attemptId !== input.pending.attemptId
        || candidate.transition !== input.pending.transition
        || !isDeepStrictEqual(candidate.transcriptEvent, input.pending.transcriptEvent)
      ));
      const { pendingVisibleEvents: _previous, ...rest } = intent;
      return {
        ...rest,
        ...(pendingVisibleEvents && pendingVisibleEvents.length > 0 ? { pendingVisibleEvents } : {}),
      };
    };
    if (this.deps.durableStore?.transact) {
      await this.deps.durableStore.transact(input.recoveryKey, (current) => {
        const intent = normalizeIntent(current.intent);
        return {
          intent: intent ? keepOtherDeliveries(intent) : null,
          effectClaimToken: current.effectClaimToken,
          result: undefined,
        };
      });
      this.scheduler.readByKeyPassive(input.recoveryKey);
      return;
    }
    const current = this.scheduler.readByKeyPassive(input.recoveryKey);
    if (!current) return;
    await this.scheduler.upsertConditionallyByKey({
      sessionId: current.sessionId,
      recoveryKey: input.recoveryKey,
      intent: keepOtherDeliveries(current),
      expectedCurrent: (candidate) => candidate.attemptId === current.attemptId,
    });
  }

  readForSession(sessionId: string): ReadonlyArray<RuntimeAuthRecoveryIntent> {
    return this.scheduler.readForSession(sessionId);
  }

  /**
   * Daemon-shutdown lifecycle: stop firing live-daemon recovery timers so recovery
   * work cannot switch/restart sessions while this daemon instance is tearing down.
   */
  dispose(): void {
    this.pendingVisibleEventDrainDisposed = true;
    if (this.pendingVisibleEventDrainTimer) clearTimeout(this.pendingVisibleEventDrainTimer);
    this.pendingVisibleEventDrainTimer = null;
    this.pendingVisibleEventDeliver = null;
    this.pendingVisibleEventDrainError = null;
    this.pendingVisibleEventDrainRequested = false;
    this.scheduler.dispose();
  }

  async wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'manual' }>): Promise<Readonly<{ status: string }>> {
    const intents = this.readForSession(input.sessionId).filter((intent) => (
      isPendingRuntimeAuthRecoveryStatus(intent.status)
    ));
    if (intents.length === 0) return { status: 'inactive' };
    if (intents.length === 1) {
      return await this.wakeByKey({
        recoveryKey: buildRecoveryKeyForIntent(intents[0]!),
        reason: input.reason,
      });
    }
    const results = [];
    for (const intent of intents) {
      results.push(await this.wakeByKey({
        recoveryKey: buildRecoveryKeyForIntent(intent),
        reason: input.reason,
      }));
    }
    if (results.some((result) => result.status === 'succeeded')) return { status: 'succeeded' };
    if (results.some((result) => result.status === 'waiting')) return { status: 'waiting' };
    if (results.some((result) => result.status === 'exhausted')) return { status: 'exhausted' };
    if (results.some((result) => result.status === 'terminal')) return { status: 'terminal' };
    if (results.some((result) => result.status === 'superseded')) return { status: 'superseded' };
    return { status: 'inactive' };
  }

  async wakeByKey(input: Readonly<{ recoveryKey: string; reason: 'timer' | 'manual' }>): Promise<Readonly<{ status: string }>> {
    return await this.scheduler.wakeByKey({
      recoveryKey: input.recoveryKey,
      reason: input.reason,
    });
  }

  async cancel(input: Readonly<{ sessionId: string }>): Promise<RuntimeAuthRecoveryIntent | null> {
    const cancelled = await this.scheduler.cancelForSession(input.sessionId);
    return cancelled[0] ?? null;
  }

  async cancelExact(input: Readonly<{ sessionId: string; attemptId: string }>): Promise<ReadonlyArray<RuntimeAuthRecoveryIntent>> {
    const matching = this.readForSession(input.sessionId).filter((intent) => intent.attemptId === input.attemptId);
    const cancelled: RuntimeAuthRecoveryIntent[] = [];
    for (const intent of matching) {
      const result = await this.markTerminalByKey({
        recoveryKey: buildRuntimeAuthRecoveryKey({
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          profileId: intent.profileId,
          groupId: intent.groupId,
        }),
        terminalReason: 'usage_limit_recovery_cancelled',
        ...(intent.attemptId ? { expectedAttemptId: intent.attemptId } : {}),
      });
      if (result) cancelled.push(result);
    }
    return cancelled;
  }

  async cancelByKey(recoveryKey: string): Promise<RuntimeAuthRecoveryIntent | null> {
    return await this.scheduler.cancelByKey(recoveryKey);
  }

  async rearmAfterConfirmedEffectOwnerLossByKey(input: Readonly<{
    recoveryKey: string;
    authorization: 'fresh_user_action_after_owner_loss';
  }>): Promise<RuntimeAuthRecoveryIntent | null> {
    return await this.scheduler.rearmAfterConfirmedEffectOwnerLossByKey(input);
  }

  async markTerminalByKey(input: Readonly<{
    recoveryKey: string;
    terminalReason: string;
    expectedAttemptId?: string;
  }>): Promise<RuntimeAuthRecoveryIntent | null> {
    const intent = this.readByKey(input.recoveryKey);
    if (!intent) return null;
    if (input.expectedAttemptId && intent.attemptId !== input.expectedAttemptId) return null;
    if (intent.status === 'exhausted') return intent;
    if (intent.status === 'cancelled' && intent.terminalReason) return intent;
    const terminal = buildTerminalRuntimeAuthIntent({
      intent: {
        ...intent,
        lastError: input.terminalReason,
      },
      nowMs: this.deps.nowMs(),
      terminalReason: input.terminalReason,
    });
    const settlement = await this.scheduler.upsertSettledByKey({
      sessionId: terminal.sessionId,
      recoveryKey: input.recoveryKey,
      intent: terminal,
      expectedCurrent: (current) => input.expectedAttemptId
        ? current.attemptId === input.expectedAttemptId
        : hasSameRuntimeAuthRecoverySettlementEpoch(current, intent),
    });
    if (settlement.status === 'stale') return input.expectedAttemptId ? null : settlement.intent;
    const transcriptEvent = buildRuntimeAuthRecoveryTerminalTranscriptEvent(terminal, input.terminalReason);
    this.record({
      event: 'runtime_auth_recovery_terminal',
      sessionId: terminal.sessionId,
      serviceId: terminal.serviceId,
      groupId: terminal.groupId,
      profileId: terminal.profileId,
      failurePhase: terminal.failurePhase,
      reason: input.terminalReason,
      classification: terminal.lastErrorClassification,
      failureKind: terminal.classification.kind,
      attemptId: terminal.attemptId,
      transition: 'terminal',
      ...(transcriptEvent ? { transcriptEvent } : {}),
    });
    return terminal;
  }

  /**
   * In-band (report-path) mirror of the scheduler-retry F0/INC-2 durable-wait
   * semantics: when the handler result is a group-exhausted `no_eligible_member`
   * or `switch_limit_reached`, re-arm the active intent as a durable wait at the
   * computed wake time — on THIS scheduler's clock — while counting the attempted
   * recovery. Terminal records are never resurrected. Returns null when the result
   * is not a durable-wait result.
   */
  async markDurableWaitForResultByKey(input: Readonly<{
    recoveryKey: string;
    result: unknown;
    classificationFailureKind?: ConnectedServiceRuntimeFailureClassification['kind'] | null;
    classificationResetsAtMs: number | null;
    expectedAttemptId?: string;
  }>): Promise<RuntimeAuthRecoveryIntent | null> {
    const intent = this.readByKey(input.recoveryKey);
    if (!intent) return null;
    if (input.expectedAttemptId && intent.attemptId !== input.expectedAttemptId) return intent;
    if (isTerminalRuntimeAuthRecoveryStatus(intent.status)) return intent;
    const attemptCount = intent.attemptCount + 1;
    const disposition = resolveRuntimeAuthRecoveryResultDisposition({
      result: input.result,
      classificationFailureKind: input.classificationFailureKind,
      classificationResetsAtMs: input.classificationResetsAtMs,
      unknownNoEligibleMemberBackoffMs: computeRuntimeAuthRecoveryBackoffMs({
        attemptCount,
        baseBackoffMs: this.baseBackoffMs,
        maxBackoffMs: this.maxBackoffMs,
        jitterMs: this.deps.jitterMs ?? (() => 0),
      }),
      nowMs: this.deps.nowMs(),
    });
    if (disposition?.kind !== 'durable_wait') return null;
    const nextRetryAtMs = disposition.nextRetryAtMs;
    const waiting = withRuntimeAuthWaitPresentation({
      ...intent,
      status: 'waiting',
      attemptCount,
      nextRetryAtMs,
      lastError: disposition.reason,
    });
    const settlement = await this.scheduler.upsertConditionallyByKey({
      sessionId: waiting.sessionId,
      recoveryKey: input.recoveryKey,
      intent: waiting,
      expectedCurrent: (current) => input.expectedAttemptId
        ? current.attemptId === input.expectedAttemptId
        : hasSameRuntimeAuthRecoverySettlementEpoch(current, intent),
    });
    if (settlement.status === 'stale') return settlement.intent;
    this.record({
      event: 'runtime_auth_recovery_delayed',
      sessionId: waiting.sessionId,
      serviceId: waiting.serviceId,
      groupId: waiting.groupId,
      profileId: waiting.profileId,
      failurePhase: waiting.failurePhase,
      reason: disposition.reason,
      nextRetryAtMs,
      classification: waiting.lastErrorClassification,
      failureKind: waiting.classification.kind,
      transcriptEvent: waiting.pendingVisibleEvents?.find((event) => event.transition === 'scheduled')?.transcriptEvent,
    });
    return waiting;
  }

  async markAwaitingProviderOutcomeProofForResultByKey(input: Readonly<{
    recoveryKey: string;
    result: unknown;
    expectedAttemptId?: string;
  }>): Promise<RuntimeAuthRecoveryIntent | null> {
    if (!isLocallyCompleteWithoutProof(input.result)) return null;
    const intent = this.readByKey(input.recoveryKey);
    if (!intent) return null;
    if (input.expectedAttemptId && intent.attemptId !== input.expectedAttemptId) return intent;
    if (isTerminalRuntimeAuthRecoveryStatus(intent.status)) return intent;
    const pendingTarget = readPendingProofTarget(input.result);
    const nextRetryAtMs = this.providerOutcomePendingWaitMs === null
      ? intent.nextRetryAtMs
      : this.deps.nowMs() + this.providerOutcomePendingWaitMs;
    const waiting: RuntimeAuthRecoveryIntent = {
      ...intent,
      status: 'resumed_awaiting_proof',
      nextRetryAtMs,
      lastError: RUNTIME_AUTH_RECOVERY_UNPROVEN_PROVIDER_OUTCOME_ERROR,
      pendingTargetProfileId: pendingTarget?.activeProfileId ?? intent.pendingTargetProfileId ?? null,
      pendingTargetGeneration: pendingTarget?.generation ?? intent.pendingTargetGeneration ?? null,
    };
    const settlement = await this.scheduler.upsertConditionallyByKey({
      sessionId: waiting.sessionId,
      recoveryKey: input.recoveryKey,
      intent: waiting,
      expectedCurrent: (current) => input.expectedAttemptId
        ? current.attemptId === input.expectedAttemptId
        : hasSameRuntimeAuthRecoverySettlementEpoch(current, intent),
    });
    if (settlement.status === 'stale') return settlement.intent;
    this.record({
      event: 'runtime_auth_recovery_delayed',
      sessionId: waiting.sessionId,
      serviceId: waiting.serviceId,
      groupId: waiting.groupId,
      profileId: waiting.profileId,
      failurePhase: waiting.failurePhase,
      reason: RUNTIME_AUTH_RECOVERY_UNPROVEN_PROVIDER_OUTCOME_ERROR,
      nextRetryAtMs: waiting.nextRetryAtMs,
      classification: waiting.lastErrorClassification,
      failureKind: waiting.classification.kind,
    });
    return waiting;
  }

  private async clearSucceededByKey(
    recoveryKey: string,
    expectedAttemptId?: string,
  ): Promise<RuntimeAuthRecoveryIntent | null> {
    const intent = this.readByKey(recoveryKey);
    if (!intent) return null;
    if (expectedAttemptId && intent.attemptId !== expectedAttemptId) return null;
    if (intent.status === 'cancelled' || intent.status === 'exhausted' || intent.status === 'recovered') return intent;
    const recovered = buildRecoveredRuntimeAuthIntent(intent, this.deps.nowMs());
    const settlement = await this.scheduler.upsertSettledByKey({
      sessionId: recovered.sessionId,
      recoveryKey,
      intent: recovered,
      expectedCurrent: (current) => expectedAttemptId
        ? current.attemptId === expectedAttemptId
        : hasSameRuntimeAuthRecoverySettlementEpoch(current, intent),
    });
    if (settlement.status === 'stale') return expectedAttemptId ? null : settlement.intent;
    this.record({
      event: 'runtime_auth_recovery_success',
      sessionId: recovered.sessionId,
      serviceId: recovered.serviceId,
      groupId: recovered.groupId,
      profileId: recovered.profileId,
      failurePhase: recovered.failurePhase,
      attemptId: recovered.attemptId,
      transition: 'recovered',
    });
    return recovered;
  }

  async markSucceededByKey(recoveryKey: string): Promise<RuntimeAuthRecoveryIntent | null> {
    return await this.clearSucceededByKey(recoveryKey);
  }

  /**
   * BANNER self-heal: an `exhausted` dead-letter means "recovery unproven", not
   * "account broken". POSITIVE provider-outcome proof on the same key (a real
   * healthy provider turn on that profile) is the strongest evidence the account
   * works, so it clears the dead-letter and publishes a terminal `recovered`
   * resolution transcript event (the dead-letter row's closing counterpart).
   * Only proof reaches here — internal success claims (`markSucceededByKey`)
   * and time passage never clear a dead-letter.
   */
  private async resolveDeadLetterByProviderOutcomeProof(
    recoveryKey: string,
    intent: RuntimeAuthRecoveryIntent,
    expectedAttemptId?: string,
  ): Promise<RuntimeAuthRecoveryIntent | null> {
    const recovered = buildRecoveredRuntimeAuthIntent(intent, this.deps.nowMs());
    const settlement = await this.scheduler.upsertSettledByKey({
      sessionId: recovered.sessionId,
      recoveryKey,
      intent: recovered,
      expectedCurrent: (current) => expectedAttemptId
        ? current.attemptId === expectedAttemptId
        : hasSameRuntimeAuthRecoverySettlementEpoch(current, intent),
    });
    if (settlement.status === 'stale') return expectedAttemptId ? null : settlement.intent;
    const reason = 'dead_letter_resolved_by_provider_outcome_proof';
    const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
      status: 'recovered',
      classification: intent.classification,
      attempt: intent.attemptCount,
      terminal: true,
      reason,
    });
    this.record({
      event: 'runtime_auth_recovery_success',
      sessionId: recovered.sessionId,
      serviceId: recovered.serviceId,
      groupId: recovered.groupId,
      profileId: recovered.profileId,
      failurePhase: recovered.failurePhase,
      reason,
      attemptCount: recovered.attemptCount,
      ...(transcriptEvent ? { transcriptEvent } : {}),
      attemptId: recovered.attemptId,
      transition: 'recovered',
    });
    return recovered;
  }

  async markProviderOutcomeProofByKey(input: Readonly<{
    recoveryKey: string;
    proofKind: ProviderOutcomeProofKind;
    expectedAttemptId?: string;
    observedAtMs?: number;
  }>): Promise<RuntimeAuthRecoveryIntent | null> {
    if (isRecoveredProviderOutcomeProof(input.proofKind)) {
      const intent = this.readByKey(input.recoveryKey);
      if (input.expectedAttemptId && intent?.attemptId !== input.expectedAttemptId) return null;
      if (
        intent
        && typeof input.observedAtMs === 'number'
        && Number.isFinite(input.observedAtMs)
        && input.observedAtMs < intent.armedAtMs
      ) return intent;
      if (
        input.proofKind === 'quota_probe_fresh'
        && intent?.classification.kind !== 'usage_limit'
        && intent?.classification.kind !== 'rate_limit'
      ) return intent;
      if (intent?.status === 'exhausted') {
        return await this.resolveDeadLetterByProviderOutcomeProof(input.recoveryKey, intent, input.expectedAttemptId);
      }
      return await this.clearSucceededByKey(input.recoveryKey, input.expectedAttemptId);
    }
    if (isTerminalProviderOutcomeProof(input.proofKind)) {
      return await this.markTerminalByKey({
        recoveryKey: input.recoveryKey,
        terminalReason: input.proofKind,
        ...(input.expectedAttemptId ? { expectedAttemptId: input.expectedAttemptId } : {}),
      });
    }
    return this.readByKey(input.recoveryKey);
  }

  async beginClassifiedFailure(input: Readonly<{
    reportId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>): Promise<RuntimeAuthRecoveryIntakeResult> {
    const classification = sanitizeConnectedServiceRuntimeFailureClassification(input.classification);
    if (!classification) return { status: 'ignored', retryable: false };
    return await this.enqueue({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification,
      decision: buildClassifiedFailureIntakeDecision({
        classification,
        nowMs: this.deps.nowMs(),
      }),
      projectScheduled: false,
      reportId: input.reportId,
      transition: 'working',
      resumePromptMode: readResumePromptMode(input.resumePromptMode),
    });
  }

  async enqueueHandlerFailure(input: Readonly<{
    reportId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    error: unknown;
    expectedAttemptId?: string;
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>): Promise<RuntimeAuthRecoveryIntakeResult> {
    return await this.enqueue({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      decision: classifyHandlerError(input.error),
      projectScheduled: true,
      reportId: input.reportId,
      transition: 'scheduled',
      expectedAttemptId: input.expectedAttemptId,
    });
  }

  async enqueueApplyFailure(input: Readonly<{
    reportId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    result: unknown;
    expectedAttemptId?: string;
  }>): Promise<RuntimeAuthRecoveryIntakeResult> {
    const decision = classifyApplyFailure(input.result);
    if (!decision) return { status: 'ignored', retryable: false };
    return await this.enqueue({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      decision,
      projectScheduled: true,
      reportId: input.reportId,
      transition: 'scheduled',
      expectedAttemptId: input.expectedAttemptId,
    });
  }

  private async enqueue(input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    decision: RetryDecision;
    projectScheduled: boolean;
    reportId?: string;
    transition: RuntimeAuthRecoveryTransition;
    expectedAttemptId?: string;
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>): Promise<RuntimeAuthRecoveryIntakeResult> {
    const classification = sanitizeConnectedServiceRuntimeFailureClassification(input.classification);
    if (!classification) return { status: 'ignored', retryable: false };
    if (!input.decision.retryable) {
      this.record({
        event: 'runtime_auth_recovery_terminal',
        sessionId: input.sessionId,
        serviceId: classification.serviceId,
        groupId: classification.groupId,
        profileId: classification.profileId,
        failurePhase: input.decision.failurePhase,
        reason: input.decision.reason,
        classification: input.decision.classification,
        failureKind: classification.kind,
      });
      return { status: 'terminal_non_retry', retryable: false };
    }

    const nowMs = this.deps.nowMs();
    const retryAfterMs = input.decision.classification.retryAfterMs;
    const nextRetryAtMs = nowMs + (
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
        ? Math.max(0, Math.trunc(retryAfterMs))
        : Math.max(1, Math.trunc(this.deps.baseBackoffMs ?? 1_000))
    );
    const attemptId = buildRuntimeAuthRecoveryAttemptId(input.reportId);
    const uxDiagnostic = input.projectScheduled
      ? buildRuntimeAuthRecoveryScheduledUxDiagnostic({
          classification,
          nextRetryAtMs,
          reason: input.decision.failureReason,
        })
      : null;
    const transcriptEvent = uxDiagnostic
      ? buildRuntimeAuthRecoveryTranscriptEvent({
          status: 'retry_scheduled',
          classification,
          uxDiagnostic,
          nextRetryAtMs,
          terminal: false,
          reason: input.decision.failureReason,
        })
      : null;
    const intent: RuntimeAuthRecoveryIntent = {
      v: 2,
      attemptId,
      lastSettledTransition: input.transition,
      ...(transcriptEvent ? {
        pendingVisibleEvents: [{ attemptId, transition: input.transition, transcriptEvent }],
      } : {}),
      sessionId: input.sessionId,
      serviceId: classification.serviceId,
      profileId: classification.profileId,
      groupId: classification.groupId,
      resumePromptMode: readResumePromptMode(input.resumePromptMode),
      status: 'waiting',
      armedAtMs: nowMs,
      // The control route owns the one initial in-band attempt. Only a typed
      // handler/apply failure transitions this intent to `scheduled` and arms
      // the durable retry timer.
      nextRetryAtMs: input.transition === 'working' ? null : nextRetryAtMs,
      attemptCount: 0,
      maxAttempts: this.maxAttempts,
      switchesThisTurn: input.switchesThisTurn,
      classification,
      failurePhase: input.decision.failurePhase,
      failureReason: input.decision.failureReason,
      lastError: input.decision.lastError,
      lastErrorClassification: input.decision.classification,
      pendingTargetProfileId: null,
      pendingTargetGeneration: null,
      terminalAtMs: null,
      terminalReason: null,
    };
    const recoveryKey = buildRecoveryKeyForIntent(intent);
    const conditionalSettlement = input.expectedAttemptId
      ? await this.scheduler.upsertConditionallyByKey({
          sessionId: input.sessionId,
          recoveryKey,
          intent,
          expectedCurrent: (current) => current.attemptId === input.expectedAttemptId
            && doesRuntimeAuthRecoveryTransitionAdvance(current.lastSettledTransition, input.transition),
          merge: mergeRuntimeAuthRecoveryIntent,
        })
      : null;
    if (conditionalSettlement?.status === 'stale') {
      return {
        status: 'stale',
        retryable: false,
        ...(conditionalSettlement.intent?.attemptId ? { attemptId: conditionalSettlement.intent.attemptId } : {}),
        ...(conditionalSettlement.intent?.lastSettledTransition
          ? { transition: conditionalSettlement.intent.lastSettledTransition }
          : {}),
      };
    }
    const persistedIntent = conditionalSettlement?.intent ?? await this.scheduler.upsertMergedByKey({
      sessionId: input.sessionId,
      recoveryKey,
      intent,
      merge: mergeRuntimeAuthRecoveryIntent,
    });
    if (persistedIntent.status === 'exhausted') {
      return {
        status: 'exhausted',
        retryable: false,
        attemptId: persistedIntent.attemptId,
        transition: persistedIntent.lastSettledTransition,
        resumePromptMode: persistedIntent.resumePromptMode,
      };
    }
    if (persistedIntent.status === 'cancelled') {
      return {
        status: 'cancelled',
        retryable: false,
        attemptId: persistedIntent.attemptId,
        transition: persistedIntent.lastSettledTransition,
      };
    }
    if (persistedIntent.status === 'recovered') {
      return {
        status: 'recovered',
        retryable: false,
        attemptId: persistedIntent.attemptId,
        transition: 'recovered',
      };
    }
    if (!input.projectScheduled) {
      return {
        status: 'scheduled',
        retryable: true,
        nextRetryAtMs: persistedIntent.nextRetryAtMs,
        attemptId: persistedIntent.attemptId,
        transition: persistedIntent.lastSettledTransition,
        resumePromptMode: persistedIntent.resumePromptMode,
      };
    }
    this.record({
      event: 'runtime_auth_recovery_enqueue',
      sessionId: persistedIntent.sessionId,
      serviceId: persistedIntent.serviceId,
      groupId: persistedIntent.groupId,
      profileId: persistedIntent.profileId,
      failurePhase: persistedIntent.failurePhase,
      reason: persistedIntent.failureReason,
      nextRetryAtMs: persistedIntent.nextRetryAtMs,
      classification: persistedIntent.lastErrorClassification,
      failureKind: persistedIntent.classification.kind,
      ...(uxDiagnostic ? { uxDiagnostic } : {}),
      ...(transcriptEvent ? { transcriptEvent } : {}),
      attemptId: persistedIntent.attemptId,
      transition: 'scheduled',
    });
    return {
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: persistedIntent.nextRetryAtMs,
      attemptId: persistedIntent.attemptId,
      transition: persistedIntent.lastSettledTransition,
      resumePromptMode: persistedIntent.resumePromptMode,
    };
  }

  private record(event: RuntimeAuthRecoveryDiagnostic): void {
    this.deps.recordDiagnostic?.(event);
  }
}
import { createHash, randomUUID } from 'node:crypto';
