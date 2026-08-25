/** Codex V3 realtime control codec and canonical event projection. */
import type {
  VoiceClientToolDefinition,
  VoiceRealtimeCanonicalEvent } from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceRealtimeJsonValue,
  VoiceRealtimeToolResult,
} from '@happier-dev/plugin-sdk/voice/client';
import {
  VoiceRealtimeJsonValueSchema,
  VoiceRealtimeToolCallV1Schema,
  VoiceRealtimeToolResultV1Schema,
  VoiceTranscriptCanonicalEventV1Schema,
} from '@happier-dev/plugin-sdk/voice/client';

const PROVIDER_NAMESPACE = 'codex-v3';
const MAX_UPSTREAM_TURN_ID_CODE_UNITS = 192;
const MAX_TRANSCRIPT_CODE_UNITS = 64 * 1024;
const MAX_PENDING_TOOL_RESPONSES = 128;
const MAX_COMPLETED_TOOL_RESPONSES = 512;

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

/**
 * Terminality is a semantic fact, not a shape check. Codex's Agent-session data
 * channel carries the OpenAI Realtime control wire, whose response status is
 * optional: a `response.done` reporting a nonterminal status must not close the
 * response or consume its accumulated tool calls, while an omitted status must
 * still close it. This mirrors the same rule the OpenAI realtime provider codec
 * applies to its own transport; each plugin owns its provider-native codec, so
 * the fact is restated here rather than shared through a host seam.
 */
const TERMINAL_RESPONSE_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
  'failed',
  'incomplete',
]);

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

function stableText(value: VoiceRealtimeJsonValue): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null;
}

function parseFunctionArguments(value: VoiceRealtimeJsonValue): VoiceRealtimeJsonValue {
  if (typeof value !== 'string') return null;
  try {
    return VoiceRealtimeJsonValueSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

function deleteOldest<T>(setOrMap: Set<T> | Map<T, unknown>): void {
  const oldest = setOrMap.keys().next();
  if (!oldest.done) setOrMap.delete(oldest.value);
}

/**
 * Codex's Agent-session data channel uses the OpenAI Realtime control wire.
 * The host owns tool eligibility and execution; this leaf only serializes the
 * already-authorized read-only tool catalog for that provider transport.
 */
export function createCodexV3ToolSessionUpdate(
  tools: readonly VoiceClientToolDefinition[],
): VoiceRealtimeJsonValue {
  return VoiceRealtimeJsonValueSchema.parse({
    type: 'session.update',
    session: {
      type: 'realtime',
      tools: tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      tool_choice: 'auto',
    },
  });
}

export function encodeCodexV3ToolResult(result: VoiceRealtimeToolResult): VoiceRealtimeJsonValue {
  const parsed = VoiceRealtimeToolResultV1Schema.parse(result);
  return VoiceRealtimeJsonValueSchema.parse({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: parsed.callId,
      output: JSON.stringify(
        parsed.status === 'success'
          ? parsed.output
          : { ok: false, errorCode: parsed.errorCode },
      ),
    },
  });
}

export function encodeCodexV3ToolContinuation(): VoiceRealtimeJsonValue {
  return VoiceRealtimeJsonValueSchema.parse({ type: 'response.create' });
}

export function encodeCodexV3ContextUpdate(text: string): VoiceRealtimeJsonValue {
  return VoiceRealtimeJsonValueSchema.parse({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: `[Context update]\n${text}` }],
    },
  });
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
  const pendingToolCalls = new Map<string, Map<string, ReturnType<typeof VoiceRealtimeToolCallV1Schema.parse>>>();
  const completedToolResponses = new Set<string>();
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
    if (event.type === 'response.function_call_arguments.done') {
      const responseId = stableText(event.response_id);
      const callId = stableText(event.call_id);
      const toolName = stableText(event.name);
      if (responseId && callId && toolName && !completedToolResponses.has(responseId)) {
        const calls = pendingToolCalls.get(responseId) ?? new Map();
        if (!calls.has(callId)) {
          const order = typeof event.output_index === 'number'
            && Number.isInteger(event.output_index)
            && event.output_index >= 0
            ? event.output_index
            : calls.size;
          const parsed = VoiceRealtimeToolCallV1Schema.safeParse({
            v: 1,
            responseId,
            callId,
            toolName,
            order,
            arguments: parseFunctionArguments(event.arguments),
          });
          if (parsed.success) calls.set(callId, parsed.data);
        }
        pendingToolCalls.set(responseId, calls);
        while (pendingToolCalls.size > MAX_PENDING_TOOL_RESPONSES) deleteOldest(pendingToolCalls);
      }
      return Object.freeze([]);
    }
    if (event.type === 'response.done') {
      const response = record(event.response);
      const status = response?.status;
      if (typeof status === 'string' && !TERMINAL_RESPONSE_STATUSES.has(status)) {
        return Object.freeze([]);
      }
      const responseId = stableText(response?.id ?? null) ?? stableText(event.response_id);
      if (!responseId || completedToolResponses.has(responseId)) return Object.freeze([]);
      const calls = pendingToolCalls.get(responseId);
      pendingToolCalls.delete(responseId);
      completedToolResponses.add(responseId);
      while (completedToolResponses.size > MAX_COMPLETED_TOOL_RESPONSES) deleteOldest(completedToolResponses);
      if (!calls?.size) return Object.freeze([]);
      return Object.freeze([{
        type: 'tool_calls',
        responseId,
        calls: Object.freeze([...calls.values()].sort(
          (left, right) => left.order - right.order || left.callId.localeCompare(right.callId),
        )),
      }]);
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
