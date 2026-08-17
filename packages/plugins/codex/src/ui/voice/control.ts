/** Codex V3 realtime control decoding and canonical event projection. */
import type {
  VoiceRealtimeCanonicalEvent } from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceRealtimeJsonValue,
} from '@happier-dev/plugin-sdk/voice';
import { VoiceTranscriptCanonicalEventV1Schema } from '@happier-dev/plugin-sdk/voice/client';

const PROVIDER_NAMESPACE = 'codex-v3';
const MAX_UPSTREAM_TURN_ID_CODE_UNITS = 192;
const MAX_TRANSCRIPT_CODE_UNITS = 64 * 1024;

type CodexV3TurnDone = Readonly<{
  upstreamTurnId: string;
  role: 'user' | 'assistant';
  transcript: string;
}>;

export type CodexV3ControlDiagnosticCode =
  | 'codex_v3_conversational_transcript_unavailable'
  | 'codex_v3_malformed_control_event'
  | 'codex_v3_malformed_turn_done'
  | 'codex_v3_unknown_control_event';

export type CodexV3ControlDecoder = ((
  value: VoiceRealtimeJsonValue,
) => readonly VoiceRealtimeCanonicalEvent[]) & Readonly<{
  /**
   * Arms whole-attempt finalization only after the upstream Agent realtime
   * attachment has actually started. A pre-start abort has no conversation
   * whose transcript availability could truthfully be classified.
   */
  markStarted(): void;
  /**
   * Settles the attempt exactly once. Zero accepted authoritative finals report
   * attempt-wide unavailability; no per-turn identity or text is inferred.
   */
  finalize(): void;
}>;

const KNOWN_INERT_EVENT_TYPES = new Set([
  'session.started',
  'session.updated',
  'output_audio.delta',
  'input_transcript.added',
  'output_transcript.added',
  'delegation.created',
  'error',
]);

function record(value: VoiceRealtimeJsonValue): Readonly<Record<string, VoiceRealtimeJsonValue>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, VoiceRealtimeJsonValue>>
    : null;
}

function decodeTurnDone(value: VoiceRealtimeJsonValue): CodexV3TurnDone | null {
  const event = record(value);
  if (event?.type !== 'turn.done') return null;
  const turn = record(event.turn);
  const upstreamTurnId = turn?.id;
  const role = turn?.role;
  const transcript = turn?.transcript;
  if (
    typeof upstreamTurnId !== 'string'
    || upstreamTurnId.length === 0
    || upstreamTurnId.length > MAX_UPSTREAM_TURN_ID_CODE_UNITS
    || upstreamTurnId.trim() !== upstreamTurnId
    || (role !== 'user' && role !== 'assistant')
    || typeof transcript !== 'string'
    || transcript.trim().length === 0
    || transcript.length > MAX_TRANSCRIPT_CODE_UNITS
  ) {
    return null;
  }
  return { upstreamTurnId, role, transcript };
}

/**
 * Strictly decodes the pinned Codex V3 Frameless Bidi `turn.done` final.
 *
 * Evidence basis: openai/codex
 * 4c43465133428898aa84f0bfc02c306ed65fb66a. The Frameless Bidi parser
 * requires role and transcript, while its official `turn.done` fixture also
 * carries `turn.id`. Happier admits only that stable fixture-shaped identity;
 * other bounded provider events remain inert until their identity/finality
 * semantics are pinned.
 */
export function createCodexV3ControlDecoder(input: Readonly<{
  attemptId: number;
  diagnostic?(code: CodexV3ControlDiagnosticCode): void;
}>): CodexV3ControlDecoder {
  const attemptIdentity = Number.isSafeInteger(input.attemptId) && input.attemptId >= 0
    ? String(input.attemptId)
    : null;
  const finalizedTurns = new Set<string>();
  const emittedDiagnosticCodes = new Set<CodexV3ControlDiagnosticCode>();
  let upstreamStarted = false;
  let terminal = false;
  let acceptedAuthoritativeFinals = 0;
  let sequence = 0;
  const diagnoseOnce = (code: CodexV3ControlDiagnosticCode): void => {
    if (emittedDiagnosticCodes.has(code)) return;
    emittedDiagnosticCodes.add(code);
    input.diagnostic?.(code);
  };

  const decode = (value: VoiceRealtimeJsonValue): readonly VoiceRealtimeCanonicalEvent[] => {
    if (attemptIdentity === null || terminal) return Object.freeze([]);
    const event = record(value);
    if (!event || typeof event.type !== 'string') {
      diagnoseOnce('codex_v3_malformed_control_event');
      return Object.freeze([]);
    }
    if (event.type !== 'turn.done') {
      if (!KNOWN_INERT_EVENT_TYPES.has(event.type)) {
        diagnoseOnce('codex_v3_unknown_control_event');
      }
      return Object.freeze([]);
    }
    const final = decodeTurnDone(value);
    if (!final) {
      diagnoseOnce('codex_v3_malformed_turn_done');
      return Object.freeze([]);
    }
    const itemId = `${PROVIDER_NAMESPACE}:${attemptIdentity}:${final.upstreamTurnId}`;
    const nextSequence = sequence + 1;
    const parsedCanonicalEvent = VoiceTranscriptCanonicalEventV1Schema.safeParse({
      type: 'voice.transcript.final',
      v: 1,
      epoch: 1,
      sequence: nextSequence,
      revision: 1,
      eventId: `${itemId}:final`,
      itemId,
      role: final.role,
      text: final.transcript,
      provenance: 'live',
    });
    if (!parsedCanonicalEvent.success) {
      diagnoseOnce('codex_v3_malformed_turn_done');
      return Object.freeze([]);
    }
    if (finalizedTurns.has(final.upstreamTurnId)) return Object.freeze([]);
    finalizedTurns.add(final.upstreamTurnId);
    acceptedAuthoritativeFinals += 1;
    sequence = nextSequence;
    return Object.freeze([{
      type: 'transcript',
      event: parsedCanonicalEvent.data,
    }]);
  };
  return Object.assign(decode, Object.freeze({
    markStarted(): void {
      if (!terminal && attemptIdentity !== null) upstreamStarted = true;
    },
    finalize(): void {
      if (terminal) return;
      terminal = true;
      if (attemptIdentity !== null && upstreamStarted && acceptedAuthoritativeFinals === 0) {
        diagnoseOnce('codex_v3_conversational_transcript_unavailable');
      }
    },
  }));
}
