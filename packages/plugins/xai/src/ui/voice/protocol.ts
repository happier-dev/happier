/** xAI Realtime Voice protocol translation. */
import {
  createVoiceTranscriptLadderMapper,
  VoiceRealtimeJsonValueSchema,
  VoiceRealtimeToolCallV1Schema } from '@happier-dev/plugin-sdk/voice/client';
import {
  type VoiceRealtimeJsonValue,
  type VoiceRealtimeToolResult as VoiceRealtimeToolResultV1,
} from '@happier-dev/plugin-sdk/voice';
import type {
  RealtimeVoiceProviderProtocol,
  VoiceRealtimeCanonicalEvent,
  VoiceTranscriptLadderObservation,
  VoiceTurnControlAction,
} from '@happier-dev/plugin-sdk/voice/client';

import type { XaiRealtimeSettingsV1 } from '../../protocol/voice/settings.js';

const MAX_PENDING_TOOL_RESPONSES = 128;
const MAX_COMPLETED_TOOL_RESPONSES = 512;
const MAX_PROCESSED_EVENT_IDS = 4_096;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * The provider's own identity for one realtime server message.
 *
 * xAI documents the Voice Agent wire as OpenAI-Realtime compatible and
 * enumerates its divergences (`conversation.item.input_audio_transcription.updated`
 * replacing `.delta`, plus the `force_message`/`resumption`/`replace`
 * extensions); `event_id` is not among them, and a live session capture carried
 * one on every server message this adapter consumes. A surrounding-whitespace
 * variant is a different string for the same message, so it cannot serve as a
 * dedupe key and is refused alongside a missing one.
 */
function providerEventId(value: unknown): string | null {
  return typeof value === 'string' && value && value.trim() === value ? value : null;
}

function parseArguments(value: unknown): VoiceRealtimeJsonValue {
  if (typeof value !== 'string') return null;
  try { return VoiceRealtimeJsonValueSchema.parse(JSON.parse(value)); } catch { return null; }
}

function optionalEntries(input: Readonly<Record<string, unknown>>): Record<string, VoiceRealtimeJsonValue> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, VoiceRealtimeJsonValue] => entry[1] !== null && entry[1] !== undefined));
}

function deleteOldest<T>(setOrMap: Set<T> | Map<T, unknown>): void {
  const oldest = setOrMap.keys().next();
  if (!oldest.done) setOrMap.delete(oldest.value);
}

export type XaiRealtimeClientToolDefinition = Readonly<{
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

export function createXaiSessionUpdate(
  settings: XaiRealtimeSettingsV1,
  clientTools: readonly XaiRealtimeClientToolDefinition[],
): VoiceRealtimeJsonValue {
  const supportsReasoning = settings.model.id === 'grok-voice-latest'
    || settings.model.id === 'grok-voice-think-fast-1.0';
  const transcription = optionalEntries({
    model: 'grok-transcribe',
    language_hint: settings.transcription.languageHint,
    keyterms: settings.transcription.keyterms.length ? settings.transcription.keyterms : undefined,
  });
  const turnDetection = optionalEntries({
    type: 'server_vad',
    threshold: settings.turnDetection.threshold,
    silence_duration_ms: settings.turnDetection.silenceDurationMs,
    prefix_padding_ms: settings.turnDetection.prefixPaddingMs,
    idle_timeout_ms: settings.turnDetection.idleTimeoutMs,
  });
  return VoiceRealtimeJsonValueSchema.parse({
    type: 'session.update',
    session: {
      voice: settings.voice.id,
      ...(settings.instructions ? { instructions: settings.instructions } : {}),
      ...(supportsReasoning ? { reasoning: { effort: settings.reasoningEffort } } : {}),
      tools: clientTools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      turn_detection: turnDetection,
      resumption: { enabled: settings.resumptionEnabled },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription,
        },
        output: {
          format: { type: 'audio/pcm', rate: 24_000 },
          speed: settings.outputSpeed,
        },
      },
    },
  });
}

export function createXaiRealtimeProtocolAdapter(input: Readonly<{
  preflight?: NonNullable<RealtimeVoiceProviderProtocol['preflight']>;
  prepare: RealtimeVoiceProviderProtocol['prepare'];
  refreshAuth?: (signal: AbortSignal) => Promise<boolean>;
  releasePrepared?: RealtimeVoiceProviderProtocol['releasePrepared'];
}>): RealtimeVoiceProviderProtocol {
  const transcriptLadder = createVoiceTranscriptLadderMapper();
  const pendingToolCalls = new Map<string, Map<string, ReturnType<typeof VoiceRealtimeToolCallV1Schema.parse>>>();
  const completedToolResponses = new Set<string>();
  const processedEventIds = new Set<string>();
  const activeOutputItems = new Map<string, string>();
  let conversationId: string | null = null;

  const transcriptEvent = (
    observation: VoiceTranscriptLadderObservation,
  ): VoiceRealtimeCanonicalEvent | null => {
    const event = transcriptLadder.map(observation);
    return event ? { type: 'transcript', event } : null;
  };

  return Object.freeze({
    preflight: input.preflight,
    prepare: input.prepare,
    refreshAuth: input.refreshAuth,
    releasePrepared: input.releasePrepared,
    decodeControl(raw: VoiceRealtimeJsonValue): readonly VoiceRealtimeCanonicalEvent[] {
      const event = record(raw);
      if (!event || typeof event.type !== 'string') return [];
      // Provider identity is the only identity this adapter has. Synthesizing
      // one from arrival order would be unstable across replay, reconnect and
      // resumption — and, because only a provider id can be a dedupe key, it
      // would also let the very events most likely to be resent walk straight
      // past the duplicate filter and concatenate their text twice. An event
      // without `event_id` therefore fails closed rather than being admitted
      // under an id that cannot mean the same thing twice.
      const eventId = providerEventId(event.event_id);
      if (!eventId) return [];
      const result: VoiceRealtimeCanonicalEvent[] = [];
      if (event.type === 'conversation.created') {
        const nextConversationId = text(record(event.conversation)?.id);
        if (nextConversationId && conversationId !== nextConversationId) {
          conversationId = nextConversationId;
          transcriptLadder.beginConversation();
          pendingToolCalls.clear();
          completedToolResponses.clear();
          processedEventIds.clear();
          activeOutputItems.clear();
        }
      }
      if (processedEventIds.has(eventId)) return Object.freeze(result);
      processedEventIds.add(eventId);
      while (processedEventIds.size > MAX_PROCESSED_EVENT_IDS) deleteOldest(processedEventIds);
      if (event.type === 'error') {
        const code = text(record(event.error)?.code) ?? '';
        if (/(?:client_secret|auth|token).*(?:expired|invalid)|(?:expired|invalid).*(?:client_secret|auth|token)/iu.test(code)) {
          result.push({ type: 'auth_expired' });
        }
      }
      const itemId = text(event.item_id) ?? text(event.response_id);
      if (event.type === 'input_audio_buffer.speech_started') {
        result.push({ type: 'input_speech_started' });
      } else if (event.type === 'input_audio_buffer.speech_stopped') {
        result.push({ type: 'input_speech_stopped' });
      }
      if (itemId && event.type === 'response.output_audio.delta' && !activeOutputItems.has(itemId)) {
        const wasIdle = activeOutputItems.size === 0;
        activeOutputItems.set(itemId, text(event.response_id) ?? itemId);
        result.push(wasIdle
          ? { type: 'assistant_output_started', itemId }
          : { type: 'assistant_output_started' });
      } else if (
        itemId
        && event.type === 'response.output_audio.done'
        && activeOutputItems.delete(itemId)
        && activeOutputItems.size === 0
      ) {
        result.push({ type: 'assistant_output_stopped' });
      }
      // A missing/blank provider transcript is not an empty transcript: it is an
      // event that carries no text of its own. Passing it through as `null`
      // leaves the ladder's accumulated text intact instead of erasing the row.
      if (itemId && event.type === 'conversation.item.input_audio_transcription.updated') {
        const mapped = transcriptEvent({ itemId, eventId, role: 'user', incoming: text(event.transcript), mode: 'updated' });
        if (mapped) result.push(mapped);
      } else if (itemId && event.type === 'conversation.item.input_audio_transcription.completed') {
        const mapped = transcriptEvent({ itemId, eventId, role: 'user', incoming: text(event.transcript), mode: 'final' });
        if (mapped) result.push(mapped);
      } else if (itemId && event.type === 'response.output_audio_transcript.delta') {
        const mapped = transcriptEvent({ itemId, eventId, role: 'assistant', incoming: text(event.delta), mode: 'delta' });
        if (mapped) result.push(mapped);
      } else if (itemId && event.type === 'response.output_audio_transcript.done') {
        // xAI may close an assistant item without restating its transcript; the
        // ladder then seals the text it already accumulated from the deltas.
        const mapped = transcriptEvent({ itemId, eventId, role: 'assistant', incoming: text(event.transcript), mode: 'final' });
        if (mapped) result.push(mapped);
      }
      if (event.type === 'response.function_call_arguments.done') {
        const responseId = text(event.response_id);
        const callId = text(event.call_id);
        const toolName = text(event.name);
        if (responseId && callId && toolName && !completedToolResponses.has(responseId)) {
          const calls = pendingToolCalls.get(responseId) ?? new Map();
          if (!calls.has(callId)) {
            const order = typeof event.output_index === 'number' && Number.isInteger(event.output_index) && event.output_index >= 0
              ? event.output_index
              : calls.size;
            const parsed = VoiceRealtimeToolCallV1Schema.safeParse({
              v: 1, responseId, callId, toolName, order, arguments: parseArguments(event.arguments),
            });
            if (parsed.success) calls.set(callId, parsed.data);
          }
          pendingToolCalls.set(responseId, calls);
          while (pendingToolCalls.size > MAX_PENDING_TOOL_RESPONSES) deleteOldest(pendingToolCalls);
        }
      }
      if (event.type === 'response.done') {
        const responseId = text(record(event.response)?.id) ?? text(event.response_id);
        if (responseId) {
          let stopped = false;
          for (const [activeItemId, activeResponseId] of activeOutputItems) {
            if (activeResponseId !== responseId) continue;
            activeOutputItems.delete(activeItemId);
            stopped = true;
          }
          if (stopped && activeOutputItems.size === 0) result.push({ type: 'assistant_output_stopped' });
        }
        const calls = responseId ? pendingToolCalls.get(responseId) : null;
        if (responseId && calls?.size && !completedToolResponses.has(responseId)) {
          completedToolResponses.add(responseId);
          while (completedToolResponses.size > MAX_COMPLETED_TOOL_RESPONSES) deleteOldest(completedToolResponses);
          pendingToolCalls.delete(responseId);
          result.push({
            type: 'tool_calls', responseId,
            calls: Object.freeze([...calls.values()].sort((left, right) => left.order - right.order || left.callId.localeCompare(right.callId))),
          });
        }
      }
      return Object.freeze(result);
    },
    encodeTurnControl(action: VoiceTurnControlAction, payload?: VoiceRealtimeJsonValue): VoiceRealtimeJsonValue | null {
      if (action === 'cancel_response') return { type: 'response.cancel' };
      if (action === 'clear_input') return { type: 'input_audio_buffer.clear' };
      if (action === 'send_exact_message') {
        const value = record(payload);
        const content = text(value?.text);
        const interruptible = typeof value?.interruptible === 'boolean' ? value.interruptible : true;
        return content ? {
          type: 'conversation.item.create',
          item: { type: 'force_message', role: 'assistant', interruptible, content: [{ type: 'output_text', text: content }] },
        } : null;
      }
      return null;
    },
  });
}

export function encodeXaiToolResult(result: VoiceRealtimeToolResultV1): VoiceRealtimeJsonValue {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: result.callId,
      output: JSON.stringify(result.status === 'success' ? result.output : { ok: false, errorCode: result.errorCode }),
    },
  };
}
