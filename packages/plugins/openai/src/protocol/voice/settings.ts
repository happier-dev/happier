import { z } from 'zod';

const ModelSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pinned'), id: z.string().trim().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('moving_alias'), id: z.literal('gpt-realtime') }).strict(),
]);

const LegacyConnectedServiceProfileBindingSchema = z.object({
  source: z.literal('connected'),
  selection: z.literal('profile'),
  profileId: z.string().trim().min(1),
}).strict();

const LegacyConnectedServiceGroupBindingSchema = z.object({
  source: z.literal('connected'),
  selection: z.literal('group'),
  groupId: z.string().trim().min(1),
}).strict();

const LegacyConnectedServiceBindingSchema = z.discriminatedUnion('selection', [
  LegacyConnectedServiceProfileBindingSchema,
  LegacyConnectedServiceGroupBindingSchema,
]);

const LegacyOpenAiRealtimeAuthenticationSourceV1Schema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('voice_saved_secret') }).strict(),
  z.object({
    source: z.literal('connected_service_api_key'),
    binding: LegacyConnectedServiceBindingSchema.optional(),
  }).strict(),
  z.object({
    source: z.literal('connected_service_oauth'),
    binding: LegacyConnectedServiceBindingSchema.optional(),
  }).strict(),
]);

/**
 * Input transcription is off unless the session configures it, and without it
 * every committed user item keeps `transcript: null` forever. The stored
 * setting stays an optional override; an empty selection resolves to this
 * realtime-oriented default so the user side of the conversation is always
 * transcribed.
 */
export const OPENAI_REALTIME_DEFAULT_INPUT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

export const OPENAI_REALTIME_DEFAULT_SETTINGS = Object.freeze({
  model: Object.freeze({ kind: 'pinned' as const, id: 'gpt-realtime-2.1' }),
  voice: 'marin',
  instructions: '',
  turnDetection: 'server_vad' as const,
  inputTranscriptionModel: '',
});

const OpenAiRealtimeSettingsV1CanonicalSchema = z.object({
  model: ModelSelectionSchema.default(OPENAI_REALTIME_DEFAULT_SETTINGS.model),
  voice: z.string().trim().min(1).max(128).default(OPENAI_REALTIME_DEFAULT_SETTINGS.voice),
  instructions: z.string().trim().max(10_000).default(''),
  turnDetection: z.enum(['server_vad', 'semantic_vad', 'manual']).default('server_vad'),
  inputTranscriptionModel: z.string().trim().max(128).default(''),
}).strict();

/**
 * Read-only compatibility contraction for settings written before qualified
 * Account Settings credential-source ownership. Authentication selection and
 * any predecessor-local binding are accepted only at ingress, then removed;
 * the runtime sees no provider-local credential authority.
 */
export const OpenAiRealtimeSettingsV1Schema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, unknown>>;
  const authentication = record.authentication;
  if (authentication !== undefined
    && !LegacyOpenAiRealtimeAuthenticationSourceV1Schema.safeParse(authentication).success) return value;
  const { authentication: _legacyAuthentication, ...current } = record;
  return {
    ...current,
    ...(current.instructions === null ? { instructions: '' } : {}),
    ...(current.inputTranscriptionModel === null ? { inputTranscriptionModel: '' } : {}),
  };
}, OpenAiRealtimeSettingsV1CanonicalSchema);

export type OpenAiRealtimeSettingsV1 = z.infer<typeof OpenAiRealtimeSettingsV1Schema>;
