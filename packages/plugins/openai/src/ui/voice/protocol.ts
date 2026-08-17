/** OpenAI Realtime Voice protocol translation. */
import {
  createVoiceTranscriptLadderMapper,
  VoiceRealtimeJsonValueSchema,
  VoiceRealtimeToolCallV1Schema,
  VoiceRealtimeToolResultV1Schema } from '@happier-dev/plugin-sdk/voice/client';
import {
  createVoiceRecordSchema,
  withVoiceSchemaField,
  type VoiceRealtimeJsonValue,
  type VoiceRealtimeToolResult as VoiceRealtimeToolResultV1,
} from '@happier-dev/plugin-sdk/voice';
import { z } from 'zod';
import type {
  RealtimeVoiceProviderProtocol,
  VoiceRealtimeCanonicalEvent,
  VoiceRealtimePreflight,
  VoiceRealtimePreparation,
  VoiceTranscriptLadderObservation,
  VoiceTurnControlAction,
} from '@happier-dev/plugin-sdk/voice/client';

const OpenAiIdSchema = z.string().min(1);
const OpenAiToolParametersSchema = createVoiceRecordSchema(VoiceRealtimeJsonValueSchema);
// Ingress contract: OpenAI server events are an upstream-owned, additively
// evolving wire. Each schema therefore requires exactly the fields this adapter
// reads and tolerates everything else. A closed allowlist here fails silently in
// the worst possible direction — `decodeOpenAiServerEvent` returns null and the
// user's authoritative words are discarded with no error, no log, and no
// distinction from an unrecognized event type. Billing (`usage`), positional
// (`content_index`, `output_index`) and diagnostic (`logprobs`) fields are never
// read, so their absence or evolution must never destroy transcript content.
// Outbound client events below stay `.strict()`: Happier authors those payloads,
// so an unexpected key there is our own bug and must fail loudly.
const OpenAiSessionCreatedEventSchema = z.object({
  type: z.literal('session.created'),
  event_id: OpenAiIdSchema,
});
const OpenAiSpeechStartedEventSchema = z.object({
  type: z.literal('input_audio_buffer.speech_started'),
  event_id: OpenAiIdSchema,
});
const OpenAiSpeechStoppedEventSchema = z.object({
  type: z.literal('input_audio_buffer.speech_stopped'),
  event_id: OpenAiIdSchema,
});
const OpenAiResponseAudioDeltaEventSchema = z.object({
  type: z.literal('response.output_audio.delta'),
  event_id: OpenAiIdSchema,
  response_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  delta: z.string().min(1),
});
const OpenAiResponseAudioDoneEventSchema = z.object({
  type: z.literal('response.output_audio.done'),
  event_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
});
const OpenAiInputTranscriptionDeltaEventSchema = z.object({
  type: z.literal('conversation.item.input_audio_transcription.delta'),
  event_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  delta: z.string().optional(),
});
const OpenAiInputTranscriptionCompletedEventSchema = z.object({
  type: z.literal('conversation.item.input_audio_transcription.completed'),
  event_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  transcript: z.string(),
});
const OpenAiOutputTranscriptDeltaEventSchema = z.object({
  type: z.literal('response.output_audio_transcript.delta'),
  event_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  delta: z.string(),
});
const OpenAiOutputTranscriptDoneEventSchema = z.object({
  type: z.literal('response.output_audio_transcript.done'),
  event_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  transcript: z.string(),
});
const OpenAiErrorEventSchema = z.object({
  type: z.literal('error'),
  event_id: OpenAiIdSchema,
  error: z.object({
    code: z.string().nullable().optional(),
  }),
});

const OpenAiResponseFunctionCallSchema = z.object({
  type: z.literal('function_call'),
  arguments: z.string(),
  name: z.string().min(1),
  call_id: OpenAiIdSchema,
});
const OpenAiResponseBaseSchema = z.object({
  id: OpenAiIdSchema,
  // Terminality is a semantic fact this adapter acts on, not a shape check: a
  // `response.done` carrying a nonterminal status must not close output, but an
  // omitted status (the pinned SDK types it optional) must not annihilate the
  // event and its tool calls. Output entries are likewise admitted per item —
  // one unrecognized entry must not cost the response its stop edge or its
  // sibling tool calls.
  status: z.string().optional(),
  output: z.unknown().optional(),
});
const OpenAiResponseSchema = withVoiceSchemaField(
  OpenAiResponseBaseSchema,
  'output',
  VoiceRealtimeJsonValueSchema.array().optional(),
);
const OpenAiResponseDoneEventBaseSchema = z.object({
  type: z.literal('response.done'),
  event_id: OpenAiIdSchema,
  response: z.unknown().nonoptional(),
});
const OpenAiResponseDoneEventSchema = withVoiceSchemaField(
  OpenAiResponseDoneEventBaseSchema,
  'response',
  OpenAiResponseSchema,
);
const OPENAI_TERMINAL_RESPONSE_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
  'failed',
  'incomplete',
]);

const OpenAiServerEventSchemaByType = Object.freeze({
  'session.created': OpenAiSessionCreatedEventSchema,
  'error': OpenAiErrorEventSchema,
  'input_audio_buffer.speech_started': OpenAiSpeechStartedEventSchema,
  'input_audio_buffer.speech_stopped': OpenAiSpeechStoppedEventSchema,
  'response.output_audio.delta': OpenAiResponseAudioDeltaEventSchema,
  'response.output_audio.done': OpenAiResponseAudioDoneEventSchema,
  'conversation.item.input_audio_transcription.delta': OpenAiInputTranscriptionDeltaEventSchema,
  'conversation.item.input_audio_transcription.completed': OpenAiInputTranscriptionCompletedEventSchema,
  'response.output_audio_transcript.delta': OpenAiOutputTranscriptDeltaEventSchema,
  'response.output_audio_transcript.done': OpenAiOutputTranscriptDoneEventSchema,
  'response.done': OpenAiResponseDoneEventSchema,
});
function isOpenAiServerEventType(
  value: string,
): value is keyof typeof OpenAiServerEventSchemaByType {
  return Object.hasOwn(OpenAiServerEventSchemaByType, value);
}
type OpenAiRecognizedServerEvent =
  | z.infer<typeof OpenAiSessionCreatedEventSchema>
  | z.infer<typeof OpenAiErrorEventSchema>
  | z.infer<typeof OpenAiSpeechStartedEventSchema>
  | z.infer<typeof OpenAiSpeechStoppedEventSchema>
  | z.infer<typeof OpenAiResponseAudioDeltaEventSchema>
  | z.infer<typeof OpenAiResponseAudioDoneEventSchema>
  | z.infer<typeof OpenAiInputTranscriptionDeltaEventSchema>
  | z.infer<typeof OpenAiInputTranscriptionCompletedEventSchema>
  | z.infer<typeof OpenAiOutputTranscriptDeltaEventSchema>
  | z.infer<typeof OpenAiOutputTranscriptDoneEventSchema>
  | ReturnType<typeof OpenAiResponseDoneEventSchema.parse>;

function decodeOpenAiServerEvent(value: VoiceRealtimeJsonValue): OpenAiRecognizedServerEvent | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.type !== 'string') return null;
  if (!isOpenAiServerEventType(candidate.type)) return null;
  const schema = OpenAiServerEventSchemaByType[candidate.type];
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const OpenAiFunctionToolBaseSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.unknown().nonoptional(),
}).strict();
const OpenAiFunctionToolSchema = withVoiceSchemaField(
  OpenAiFunctionToolBaseSchema,
  'parameters',
  OpenAiToolParametersSchema,
);
const OpenAiSessionBaseSchema = z.object({
  type: z.literal('realtime'),
  tools: z.array(z.unknown()),
  tool_choice: z.literal('auto'),
}).strict();
const OpenAiSessionSchema = withVoiceSchemaField(
  OpenAiSessionBaseSchema,
  'tools',
  OpenAiFunctionToolSchema.array(),
);
const OpenAiSessionUpdateBaseSchema = z.object({
  type: z.literal('session.update'),
  event_id: OpenAiIdSchema.optional(),
  session: z.unknown().nonoptional(),
}).strict();
const OpenAiFunctionCallOutputItemSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: OpenAiIdSchema,
  output: z.string(),
}).strict();
const OpenAiInputTextContentSchema = z.object({
  type: z.literal('input_text'),
  text: z.string().min(1),
}).strict();
const OpenAiMessageItemSchema = z.discriminatedUnion('role', [
  z.object({
    type: z.literal('message'),
    role: z.literal('system'),
    content: z.array(OpenAiInputTextContentSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal('message'),
    role: z.literal('user'),
    content: z.array(OpenAiInputTextContentSchema).min(1),
  }).strict(),
]);
const OpenAiConversationItemCreateEventSchema = z.object({
  type: z.literal('conversation.item.create'),
  event_id: OpenAiIdSchema.optional(),
  previous_item_id: OpenAiIdSchema.optional(),
  item: z.union([
    OpenAiFunctionCallOutputItemSchema,
    OpenAiMessageItemSchema,
  ]),
}).strict();
const OpenAiResponseCancelEventSchema = z.object({
  type: z.literal('response.cancel'),
  event_id: OpenAiIdSchema.optional(),
  response_id: OpenAiIdSchema.optional(),
}).strict();
const OpenAiInputAudioBufferClearEventSchema = z.object({
  type: z.literal('input_audio_buffer.clear'),
  event_id: OpenAiIdSchema.optional(),
}).strict();
const OpenAiOutputAudioBufferClearEventSchema = z.object({
  type: z.literal('output_audio_buffer.clear'),
  event_id: OpenAiIdSchema.optional(),
}).strict();
const OpenAiResponseCreateEventBaseSchema = z.object({
  type: z.literal('response.create'),
  event_id: OpenAiIdSchema.optional(),
  response: z.unknown().optional(),
}).strict();
const OpenAiClientEventBaseSchema = z.discriminatedUnion('type', [
  OpenAiSessionUpdateBaseSchema,
  OpenAiConversationItemCreateEventSchema,
  OpenAiResponseCancelEventSchema,
  OpenAiInputAudioBufferClearEventSchema,
  OpenAiOutputAudioBufferClearEventSchema,
  OpenAiResponseCreateEventBaseSchema,
]);
const OpenAiClientEventWithSessionSchema = withVoiceSchemaField(
  OpenAiClientEventBaseSchema,
  'session',
  OpenAiSessionSchema,
);
const OpenAiClientEventSchema = withVoiceSchemaField(
  OpenAiClientEventWithSessionSchema,
  'response',
  VoiceRealtimeJsonValueSchema.optional(),
);

function isOpenAiRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return isOpenAiRecord(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseArguments(value: unknown): VoiceRealtimeJsonValue {
  if (typeof value !== 'string') return null;
  try { return VoiceRealtimeJsonValueSchema.parse(JSON.parse(value)); } catch { return null; }
}

export type OpenAiRealtimeClientToolDefinition = Readonly<{
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

export function encodeOpenAiRealtimeClientEvent(value: unknown): VoiceRealtimeJsonValue {
  return VoiceRealtimeJsonValueSchema.parse(OpenAiClientEventSchema.parse(value));
}

export function createOpenAiToolSessionUpdate(
  clientTools: readonly OpenAiRealtimeClientToolDefinition[],
): VoiceRealtimeJsonValue {
  return encodeOpenAiRealtimeClientEvent({
    type: 'session.update',
    session: {
      type: 'realtime',
      tools: clientTools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      tool_choice: 'auto',
    },
  });
}

export function createOpenAiRealtimeProtocolAdapter(input: Readonly<{
  preflight?: (
    params: Parameters<NonNullable<RealtimeVoiceProviderProtocol['preflight']>>[0],
  ) => Promise<VoiceRealtimePreflight>;
  prepare: (
    params: Parameters<RealtimeVoiceProviderProtocol['prepare']>[0],
  ) => Promise<VoiceRealtimePreparation>;
  refreshAuth?: (signal: AbortSignal) => Promise<boolean>;
  releasePrepared?: RealtimeVoiceProviderProtocol['releasePrepared'];
}>): RealtimeVoiceProviderProtocol {
  const transcriptLadder = createVoiceTranscriptLadderMapper();
  const seenEventIds = new Set<string>();
  const seenEventOrder: string[] = [];
  const activeOutputItems = new Map<string, string>();

  const rememberEventId = (eventId: string): boolean => {
    if (seenEventIds.has(eventId)) return false;
    seenEventIds.add(eventId);
    seenEventOrder.push(eventId);
    while (seenEventOrder.length > 4_096) {
      seenEventIds.delete(seenEventOrder.shift()!);
    }
    return true;
  };

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
      const event = decodeOpenAiServerEvent(raw);
      if (!event) return [];
      const result: VoiceRealtimeCanonicalEvent[] = [];
      const providerEventId = event.event_id;
      if (seenEventIds.has(providerEventId)) return Object.freeze(result);
      if (event.type === 'session.created') {
        transcriptLadder.beginConversation();
        seenEventIds.clear();
        seenEventOrder.length = 0;
        activeOutputItems.clear();
      }
      rememberEventId(providerEventId);
      const eventId = providerEventId;
      if (event.type === 'error') {
        const code = text(event.error.code);
        if (code && /(?:client_secret|auth|token).*(?:expired|invalid)|(?:expired|invalid).*(?:client_secret|auth|token)/iu.test(code)) {
          result.push({ type: 'auth_expired' });
        }
      }
      if (event.type === 'input_audio_buffer.speech_started') {
        result.push({ type: 'input_speech_started' });
      } else if (event.type === 'input_audio_buffer.speech_stopped') {
        result.push({ type: 'input_speech_stopped' });
      }
      if (event.type === 'response.output_audio.delta' && !activeOutputItems.has(event.item_id)) {
        const wasIdle = activeOutputItems.size === 0;
        activeOutputItems.set(event.item_id, event.response_id);
        result.push(wasIdle
          ? { type: 'assistant_output_started', itemId: event.item_id }
          : { type: 'assistant_output_started' });
      } else if (
        event.type === 'response.output_audio.done'
        && activeOutputItems.delete(event.item_id)
        && activeOutputItems.size === 0
      ) {
        result.push({ type: 'assistant_output_stopped' });
      }
      if (event.type === 'conversation.item.input_audio_transcription.delta') {
        const mapped = transcriptEvent({ itemId: event.item_id, eventId, role: 'user', incoming: event.delta ?? '', mode: 'delta' });
        if (mapped) result.push(mapped);
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        // A blank provider transcript is not an empty transcript: it is a final
        // that carries no text of its own. Passing it through as `null` seals
        // the text the ladder already accumulated instead of erasing the turn —
        // an empty canonical final reaches the host writer and is discarded
        // there with no row and no record.
        const mapped = transcriptEvent({ itemId: event.item_id, eventId, role: 'user', incoming: text(event.transcript), mode: 'final' });
        if (mapped) result.push(mapped);
      } else if (event.type === 'response.output_audio_transcript.delta') {
        const mapped = transcriptEvent({ itemId: event.item_id, eventId, role: 'assistant', incoming: event.delta, mode: 'delta' });
        if (mapped) result.push(mapped);
      } else if (event.type === 'response.output_audio_transcript.done') {
        const mapped = transcriptEvent({ itemId: event.item_id, eventId, role: 'assistant', incoming: text(event.transcript), mode: 'final' });
        if (mapped) result.push(mapped);
      }
      if (
        event.type === 'response.done'
        && (
          event.response.status === undefined
          || OPENAI_TERMINAL_RESPONSE_STATUSES.has(event.response.status)
        )
      ) {
        const response = event.response;
        const responseId = response.id;
        let stopped = false;
        for (const [activeItemId, activeResponseId] of activeOutputItems) {
          if (activeResponseId !== responseId) continue;
          activeOutputItems.delete(activeItemId);
          stopped = true;
        }
        if (stopped && activeOutputItems.size === 0) result.push({ type: 'assistant_output_stopped' });
        const calls = (response.output ?? []).flatMap((rawCall, order) => {
          const parsedCall = OpenAiResponseFunctionCallSchema.safeParse(rawCall);
          if (!parsedCall.success) return [];
          const call = parsedCall.data;
          const parsed = VoiceRealtimeToolCallV1Schema.safeParse({
            v: 1,
            responseId,
            callId: call.call_id,
            toolName: call.name,
            order,
            arguments: parseArguments(call.arguments),
          });
          return parsed.success ? [parsed.data] : [];
        });
        if (calls.length) {
          result.push({
            type: 'tool_calls',
            responseId,
            calls: Object.freeze(calls),
          });
        }
      }
      return Object.freeze(result);
    },
    encodeTurnControl(action: VoiceTurnControlAction): VoiceRealtimeJsonValue | null {
      if (action === 'cancel_response') return encodeOpenAiRealtimeClientEvent({ type: 'response.cancel' });
      if (action === 'clear_input') return encodeOpenAiRealtimeClientEvent({ type: 'input_audio_buffer.clear' });
      return null;
    },
  });
}

export function encodeOpenAiToolResult(result: VoiceRealtimeToolResultV1): VoiceRealtimeJsonValue {
  const parsedResult = VoiceRealtimeToolResultV1Schema.parse(result);
  return encodeOpenAiRealtimeClientEvent({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: parsedResult.callId,
      output: JSON.stringify(
        parsedResult.status === 'success'
          ? parsedResult.output
          : { ok: false, errorCode: parsedResult.errorCode },
      ),
    },
  });
}
