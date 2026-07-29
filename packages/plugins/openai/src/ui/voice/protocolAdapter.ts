import {
  VoiceRealtimeJsonValueSchema,
  VoiceRealtimeToolCallV1Schema,
  VoiceRealtimeToolResultV1Schema,
  VoiceTranscriptCanonicalEventV1Schema,
  type VoiceRealtimeJsonValue,
  type VoiceRealtimeToolResultV1,
} from '@happier-dev/protocol';
import { z } from 'zod';
import type {
  PluginVoiceProviderProtocol,
  PluginVoiceRealtimeCanonicalEvent,
  PluginVoiceRealtimePreflight,
  PluginVoiceRealtimePreparation,
  PluginVoiceTurnControlAction,
} from '@happier-dev/plugin-sdk/runtime';

const MAX_TRANSCRIPT_ITEMS = 2_048;

const OpenAiIdSchema = z.string().min(1);
const OpenAiIndexSchema = z.number().int().nonnegative();
const OpenAiLogProbSchema = z.object({
  token: z.string(),
  bytes: z.array(z.number().int().min(0).max(255)),
  logprob: z.number(),
}).strict();
const OpenAiTranscriptionUsageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tokens'),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    input_token_details: z.object({
      audio_tokens: z.number().int().nonnegative().optional(),
      text_tokens: z.number().int().nonnegative().optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    type: z.literal('duration'),
    seconds: z.number().nonnegative(),
  }).strict(),
]);

// Provider envelopes are pinned to the official OpenAI SDK 6.26.0
// resources/realtime/realtime.d.ts contract. Fields that this adapter consumes
// are required before event IDs or canonical state can be mutated.
const OpenAiSessionCreatedEventSchema = z.object({
  type: z.literal('session.created'),
  event_id: OpenAiIdSchema,
  // The adapter only consumes the realtime discriminator. The effective
  // session body is upstream-owned and intentionally remains opaque here.
  session: z.object({ type: z.literal('realtime') }).loose(),
}).strict();
const OpenAiSpeechStartedEventSchema = z.object({
  type: z.literal('input_audio_buffer.speech_started'),
  event_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  audio_start_ms: OpenAiIndexSchema,
}).strict();
const OpenAiSpeechStoppedEventSchema = z.object({
  type: z.literal('input_audio_buffer.speech_stopped'),
  event_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  audio_end_ms: OpenAiIndexSchema,
}).strict();
const OpenAiResponseAudioDeltaEventSchema = z.object({
  type: z.literal('response.output_audio.delta'),
  event_id: OpenAiIdSchema,
  response_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  output_index: OpenAiIndexSchema,
  content_index: OpenAiIndexSchema,
  delta: z.string().min(1),
}).strict();
const OpenAiResponseAudioDoneEventSchema = z.object({
  type: z.literal('response.output_audio.done'),
  event_id: OpenAiIdSchema,
  response_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  output_index: OpenAiIndexSchema,
  content_index: OpenAiIndexSchema,
}).strict();
const OpenAiInputTranscriptionDeltaEventSchema = z.object({
  type: z.literal('conversation.item.input_audio_transcription.delta'),
  event_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  content_index: OpenAiIndexSchema.optional(),
  delta: z.string().optional(),
  logprobs: z.array(OpenAiLogProbSchema).nullable().optional(),
}).strict();
const OpenAiInputTranscriptionCompletedEventSchema = z.object({
  type: z.literal('conversation.item.input_audio_transcription.completed'),
  event_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  content_index: OpenAiIndexSchema,
  transcript: z.string(),
  usage: OpenAiTranscriptionUsageSchema,
  logprobs: z.array(OpenAiLogProbSchema).nullable().optional(),
}).strict();
const OpenAiOutputTranscriptDeltaEventSchema = z.object({
  type: z.literal('response.output_audio_transcript.delta'),
  event_id: OpenAiIdSchema,
  response_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  output_index: OpenAiIndexSchema,
  content_index: OpenAiIndexSchema,
  delta: z.string(),
}).strict();
const OpenAiOutputTranscriptDoneEventSchema = z.object({
  type: z.literal('response.output_audio_transcript.done'),
  event_id: OpenAiIdSchema,
  response_id: OpenAiIdSchema,
  item_id: OpenAiIdSchema,
  output_index: OpenAiIndexSchema,
  content_index: OpenAiIndexSchema,
  transcript: z.string(),
}).strict();
const OpenAiErrorEventSchema = z.object({
  type: z.literal('error'),
  event_id: OpenAiIdSchema,
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string().nullable().optional(),
    event_id: z.string().nullable().optional(),
    param: z.string().nullable().optional(),
  }).strict(),
}).strict();

const OpenAiResponseFunctionCallSchema = z.object({
  type: z.literal('function_call'),
  arguments: z.string(),
  name: z.string().min(1),
  call_id: OpenAiIdSchema,
  id: OpenAiIdSchema.optional(),
  object: z.literal('realtime.item').optional(),
  status: z.enum(['completed', 'incomplete', 'in_progress']).optional(),
}).strict();
const OpenAiResponseOutputItemSchema = VoiceRealtimeJsonValueSchema.superRefine((item, context) => {
  const candidate = record(item);
  if (!candidate || typeof candidate.type !== 'string' || !candidate.type) {
    context.addIssue({
      code: 'custom',
      message: 'OpenAI response output entries must be typed items',
    });
    return;
  }
  if (candidate.type === 'function_call' && !OpenAiResponseFunctionCallSchema.safeParse(candidate).success) {
    context.addIssue({
      code: 'custom',
      message: 'malformed OpenAI function_call output item',
    });
  }
});
const OpenAiResponseSchema = z.object({
  id: OpenAiIdSchema,
  object: z.literal('realtime.response'),
  status: z.enum(['completed', 'cancelled', 'failed', 'incomplete']),
  output: z.array(OpenAiResponseOutputItemSchema),
  audio: VoiceRealtimeJsonValueSchema.optional(),
  conversation_id: z.string().nullable().optional(),
  max_output_tokens: z.union([z.number().int().positive(), z.literal('inf')]).optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  output_modalities: z.array(z.enum(['text', 'audio'])).optional(),
  status_details: VoiceRealtimeJsonValueSchema.optional(),
  usage: VoiceRealtimeJsonValueSchema.optional(),
}).strict();
const OpenAiResponseDoneEventSchema = z.object({
  type: z.literal('response.done'),
  event_id: OpenAiIdSchema,
  response: OpenAiResponseSchema,
}).strict();

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
  | z.infer<typeof OpenAiResponseDoneEventSchema>;

function decodeOpenAiServerEvent(value: VoiceRealtimeJsonValue): OpenAiRecognizedServerEvent | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.type !== 'string') return null;
  const schema = OpenAiServerEventSchemaByType[
    candidate.type as keyof typeof OpenAiServerEventSchemaByType
  ];
  if (!schema) return null;
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data as OpenAiRecognizedServerEvent : null;
}

const OpenAiFunctionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), VoiceRealtimeJsonValueSchema),
}).strict();
const OpenAiSessionUpdateEventSchema = z.object({
  type: z.literal('session.update'),
  event_id: OpenAiIdSchema.optional(),
  session: z.object({
    type: z.literal('realtime'),
    tools: z.array(OpenAiFunctionToolSchema),
    tool_choice: z.literal('auto'),
  }).strict(),
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
const OpenAiResponseCreateEventSchema = z.object({
  type: z.literal('response.create'),
  event_id: OpenAiIdSchema.optional(),
  response: VoiceRealtimeJsonValueSchema.optional(),
}).strict();
const OpenAiClientEventSchema = z.discriminatedUnion('type', [
  OpenAiSessionUpdateEventSchema,
  OpenAiConversationItemCreateEventSchema,
  OpenAiResponseCancelEventSchema,
  OpenAiInputAudioBufferClearEventSchema,
  OpenAiOutputAudioBufferClearEventSchema,
  OpenAiResponseCreateEventSchema,
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
  const providerEvent = OpenAiClientEventSchema.parse(value);
  return VoiceRealtimeJsonValueSchema.parse(providerEvent);
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
    params: Parameters<NonNullable<PluginVoiceProviderProtocol['preflight']>>[0],
  ) => Promise<PluginVoiceRealtimePreflight>;
  prepare: (
    params: Parameters<PluginVoiceProviderProtocol['prepare']>[0],
  ) => Promise<PluginVoiceRealtimePreparation>;
  refreshAuth?: (signal: AbortSignal) => Promise<boolean>;
  releasePrepared?: PluginVoiceProviderProtocol['releasePrepared'];
}>): PluginVoiceProviderProtocol {
  const transcripts = new Map<string, { text: string; revision: number; final: boolean }>();
  let sequence = 0;
  let epoch = 0;
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

  const transcriptEvent = (params: Readonly<{
    itemId: string; eventId: string; role: 'user' | 'assistant'; incoming: string; mode: 'delta' | 'updated' | 'final';
  }>): PluginVoiceRealtimeCanonicalEvent | null => {
    const previous = transcripts.get(params.itemId) ?? { text: '', revision: 0, final: false };
    const nextText = params.mode === 'delta' ? `${previous.text}${params.incoming}` : params.incoming;
    if (nextText === previous.text && (params.mode !== 'final' || previous.final)) return null;
    const revision = previous.revision + 1;
    const correction = previous.final && nextText !== previous.text;
    const final = params.mode === 'final' || correction;
    transcripts.set(params.itemId, { text: nextText, revision, final });
    while (transcripts.size > MAX_TRANSCRIPT_ITEMS) {
      const oldest = transcripts.keys().next();
      if (oldest.done) break;
      transcripts.delete(oldest.value);
    }
    const type = correction
      ? 'voice.transcript.corrected'
      : final ? 'voice.transcript.final'
        : params.mode === 'delta' ? 'voice.transcript.delta' : 'voice.transcript.updated';
    return {
      type: 'transcript',
      event: VoiceTranscriptCanonicalEventV1Schema.parse({
        v: 1, type, epoch, sequence: ++sequence, revision,
        eventId: params.eventId, itemId: params.itemId, role: params.role,
        text: params.mode === 'delta' && !correction ? params.incoming : nextText,
        provenance: 'live',
      }),
    };
  };

  return Object.freeze({
    preflight: input.preflight,
    prepare: input.prepare,
    refreshAuth: input.refreshAuth,
    releasePrepared: input.releasePrepared,
    decodeControl(raw: VoiceRealtimeJsonValue): readonly PluginVoiceRealtimeCanonicalEvent[] {
      const event = decodeOpenAiServerEvent(raw);
      if (!event) return [];
      const result: PluginVoiceRealtimeCanonicalEvent[] = [];
      const providerEventId = event.event_id;
      if (seenEventIds.has(providerEventId)) return Object.freeze(result);
      if (event.type === 'session.created') {
        epoch += 1;
        sequence = 0;
        transcripts.clear();
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
        const mapped = transcriptEvent({ itemId: event.item_id, eventId, role: 'user', incoming: event.transcript, mode: 'final' });
        if (mapped) result.push(mapped);
      } else if (event.type === 'response.output_audio_transcript.delta') {
        const mapped = transcriptEvent({ itemId: event.item_id, eventId, role: 'assistant', incoming: event.delta, mode: 'delta' });
        if (mapped) result.push(mapped);
      } else if (event.type === 'response.output_audio_transcript.done') {
        const mapped = transcriptEvent({ itemId: event.item_id, eventId, role: 'assistant', incoming: event.transcript, mode: 'final' });
        if (mapped) result.push(mapped);
      }
      if (event.type === 'response.done') {
        const response = event.response;
        const responseId = response.id;
        let stopped = false;
        for (const [activeItemId, activeResponseId] of activeOutputItems) {
          if (activeResponseId !== responseId) continue;
          activeOutputItems.delete(activeItemId);
          stopped = true;
        }
        if (stopped && activeOutputItems.size === 0) result.push({ type: 'assistant_output_stopped' });
        const calls = response.output.flatMap((rawCall, order) => {
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
    encodeTurnControl(action: PluginVoiceTurnControlAction): VoiceRealtimeJsonValue | null {
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
