import { log } from '@/log';
import { normalizeVoiceFailureCode } from '@happier-dev/protocol/voice/providerOperations';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { isVoiceTextTurnRejectedBeforeEffectError } from '@/voice/session/types';
import { ActionFailureCauseV1Schema, projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readSessionRuntimeFailureCause, SessionRuntimeIssueV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type {
  VoiceConversationSessionMetadataCommitReason,
} from '@/voice/persistence/voiceConversationSession';

const VOICE_CONVERSATION_METADATA_COMMIT_FAILED =
  'VOICE_CONVERSATION_METADATA_COMMIT_FAILED';

export type VoiceRuntimeFailureDiagnosticReason =
  VoiceConversationSessionMetadataCommitReason;

const VOICE_RUNTIME_FAILURE_DIAGNOSTIC_REASONS: Readonly<
  Record<VoiceRuntimeFailureDiagnosticReason, true>
> = Object.freeze({
  session_refresh_failed: true,
  session_metadata_wait_timed_out: true,
  metadata_write_rejected: true,
  unknown: true,
});

/**
 * How a Voice runtime outcome ended badly.
 *
 * `declined`/`failed` are named by the provider runtime's machine ports.
 * `unsettled` covers a Start the controller refused or abandoned without
 * reaching a port. `unstarted` covers a Start the lifecycle owner refused
 * before any provider runtime was involved at all — the only outcomes that
 * otherwise leave no trace anywhere.
 *
 * `unregistered` covers a provider runtime excluded while its bundled leaf was
 * composed, so it never reaches the adapter registry and no Start of it can
 * report anything. It is recorded once per excluded leaf per composition.
 *
 * `transcript_dropped` covers an authoritative transcript event the runtime
 * refused to project. A conversation keeps running after such a refusal — for a
 * WebRTC provider the user still hears and is heard — so the loss is otherwise
 * indistinguishable from a provider that never spoke. It is recorded once per
 * guard per attempt, never once per event.
 *
 * `unapplied` covers an explicit Voice settings gesture — the user chose a
 * concrete outcome — that reached no write. Such a gesture is otherwise
 * indistinguishable from one that was never delivered at all: the surface
 * closes, nothing changes, and nothing is reported. It is recorded once per
 * gesture.
 *
 * `provider_error` records a sanitized, nonterminal provider diagnostic. It
 * does not mark the conversation failed or authorize reconnect or retries.
 */
export type VoiceRuntimeFailureOutcome =
  | 'declined'
  | 'failed'
  | 'unsettled'
  | 'unstarted'
  | 'unregistered'
  | 'transcript_dropped'
  | 'provider_error'
  | 'unapplied';

/**
 * Sole record for Voice runtime failure outcomes, including sanitized
 * nonterminal provider diagnostics and refused transcript projection.
 *
 * Every error kind renders as one generic status label and a pre-flight refusal
 * can end a Start before any provider request or microphone acquisition, so the
 * typed reason is unrecoverable unless it is named here. Only safe codes are
 * recorded; credentials, headers, and provider payloads never are — in
 * particular a dropped transcript records the guard, never the user's words.
 */
export function recordVoiceRuntimeFailure(
  providerId: string,
  outcome: VoiceRuntimeFailureOutcome,
  kind: string,
  reason: string,
  diagnosticReason?: unknown,
  providerCode?: string,
  failureCause?: VoiceRuntimeFailureCause,
): void {
  log.log(`[voiceRuntimeFailure] ${JSON.stringify({
    providerId,
    outcome,
    kind,
    reason,
    ...readSafeVoiceRuntimeFailureFacts({ failureCause }),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(diagnosticReason === undefined
      ? {}
      : {
          diagnosticReason: normalizeVoiceRuntimeFailureDiagnosticReason(diagnosticReason),
        }),
  })}`);
}

export function normalizeVoiceRuntimeFailureDiagnosticReason(
  reason: unknown,
): VoiceRuntimeFailureDiagnosticReason {
  return typeof reason === 'string'
    && Object.prototype.hasOwnProperty.call(VOICE_RUNTIME_FAILURE_DIAGNOSTIC_REASONS, reason)
    ? reason as VoiceRuntimeFailureDiagnosticReason
    : 'unknown';
}

export function readSafeVoiceRuntimeFailureDiagnosticReason(
  error: unknown,
): VoiceRuntimeFailureDiagnosticReason | undefined {
  if (!error || typeof error !== 'object') return undefined;
  try {
    if (readSafeVoiceRuntimeFailureCode(error) !== VOICE_CONVERSATION_METADATA_COMMIT_FAILED) {
      return undefined;
    }
    return normalizeVoiceRuntimeFailureDiagnosticReason(
      (error as Readonly<{ reason?: unknown }>).reason,
    );
  } catch {
    return undefined;
  }
}

export function readSafeVoiceRuntimeFailureCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  // Pending custody needs the definite pre-effect envelope; recovery and safe
  // diagnostics need the acquisition refusal it wraps, without its private prose.
  const cause = isVoiceTextTurnRejectedBeforeEffectError(error) ? error.cause : null;
  for (const candidate of [cause, error]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const code = readRpcErrorCode(candidate) ?? (candidate as Readonly<{ code?: unknown }>).code;
    const normalized = normalizeVoiceFailureCode(code);
    if (normalized) return normalized;
  }
  return null;
}

export function normalizeVoiceRuntimeFailureCode(code: unknown): string {
  return normalizeVoiceFailureCode(code) ?? 'voice_connection_failed';
}

export type VoiceRuntimeFailureCause = ActionFailureCauseV1
  | NonNullable<SessionRuntimeIssueV1['failureCause']>;

/** Native issues carry producer-redacted prose; generic launch errors carry only operation facts. */
export function readSafeVoiceRuntimeFailureFacts(error: unknown): Readonly<{
  failureCause?: VoiceRuntimeFailureCause;
  effectAttempted?: boolean;
}> {
  const cause = isVoiceTextTurnRejectedBeforeEffectError(error) ? error.cause : error;
  if (!cause || typeof cause !== 'object') return {};
  let failureCause: VoiceRuntimeFailureCause | undefined;
  // Capture and machine wrappers retain the original error as their immediate cause.
  const candidates = [cause, 'cause' in cause ? cause.cause : undefined];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const runtimeIssue = 'runtimeIssueV1' in candidate ? SessionRuntimeIssueV1Schema.safeParse(candidate.runtimeIssueV1) : null;
    const actionCause = 'failureCause' in candidate ? ActionFailureCauseV1Schema.safeParse(candidate.failureCause) : null;
    const sessionCause = readSessionRuntimeFailureCause(candidate);
    failureCause = runtimeIssue?.success && runtimeIssue.data.failureCause
      ? runtimeIssue.data.failureCause
      : actionCause?.success ? actionCause.data : sessionCause
        ? (({ providerErrorMessage: _privateMessage, ...safeCause }) => safeCause)(sessionCause) : undefined;
    if (failureCause) break;
  }
  if (!failureCause) {
    const nativeError = candidates.find(candidate => candidate instanceof Error);
    if (nativeError) failureCause = projectActionFailureCauseV1(nativeError, 'voice.runtime', { allowUnknownErrorCode: false });
  }
  return {
    ...(failureCause ? { failureCause } : {}),
    ...('effectAttempted' in cause && typeof cause.effectAttempted === 'boolean' ? { effectAttempted: cause.effectAttempted } : {}),
  };
}
