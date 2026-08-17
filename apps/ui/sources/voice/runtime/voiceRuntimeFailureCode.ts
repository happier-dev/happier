import { log } from '@/log';
import type {
  VoiceConversationSessionMetadataCommitReason,
} from '@/voice/persistence/voiceConversationSession';

const SAFE_VOICE_RUNTIME_FAILURE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
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
 */
export type VoiceRuntimeFailureOutcome =
  | 'declined'
  | 'failed'
  | 'unsettled'
  | 'unstarted'
  | 'unregistered'
  | 'transcript_dropped'
  | 'unapplied';

/**
 * Sole record for a Voice Start that did not connect and for an authoritative
 * transcript event the runtime refused to project.
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
): void {
  log.log(`[voiceRuntimeFailure] ${JSON.stringify({
    providerId,
    outcome,
    kind,
    reason,
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
  const code = (error as Readonly<{ code?: unknown }>).code;
  if (typeof code !== 'string') return null;
  const normalized = code.trim();
  return SAFE_VOICE_RUNTIME_FAILURE_CODE_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeVoiceRuntimeFailureCode(code: unknown): string {
  if (typeof code !== 'string') return 'voice_connection_failed';
  const normalized = code.trim();
  return SAFE_VOICE_RUNTIME_FAILURE_CODE_PATTERN.test(normalized)
    ? normalized
    : 'voice_connection_failed';
}
