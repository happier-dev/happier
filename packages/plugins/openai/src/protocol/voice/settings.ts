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

export const OpenAiRealtimeAuthenticationSourceV1Schema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('voice_saved_secret') }).strict(),
  z.object({ source: z.literal('connected_service_api_key') }).strict(),
  z.object({ source: z.literal('connected_service_oauth') }).strict(),
]);

export type OpenAiRealtimeAuthenticationSourceV1 = z.infer<typeof OpenAiRealtimeAuthenticationSourceV1Schema>;

export const OPENAI_REALTIME_DEFAULT_SETTINGS = Object.freeze({
  authentication: Object.freeze({ source: 'voice_saved_secret' as const }),
  model: Object.freeze({ kind: 'pinned' as const, id: 'gpt-realtime-2.1' }),
  voice: 'marin',
  instructions: null,
  turnDetection: 'server_vad' as const,
  inputTranscriptionModel: null,
});

const OpenAiRealtimeSettingsV1CanonicalSchema = z.object({
  authentication: OpenAiRealtimeAuthenticationSourceV1Schema.default(OPENAI_REALTIME_DEFAULT_SETTINGS.authentication),
  model: ModelSelectionSchema.default(OPENAI_REALTIME_DEFAULT_SETTINGS.model),
  voice: z.string().trim().min(1).max(128).default(OPENAI_REALTIME_DEFAULT_SETTINGS.voice),
  instructions: z.string().trim().max(16_384).nullable().default(null),
  turnDetection: z.enum(['server_vad', 'semantic_vad', 'manual']).default('server_vad'),
  inputTranscriptionModel: z.string().trim().min(1).max(128).nullable().default(null),
}).strict();

/**
 * Read-only compatibility contraction for settings written before qualified
 * purpose ownership. A valid released API-key binding is discarded because
 * the daemon purpose owner now holds the target. The undeployed legacy Codex
 * OAuth binding is deliberately not translated; its new explicit source uses
 * a separate qualified purpose owned by the daemon.
 */
export const OpenAiRealtimeSettingsV1Schema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, unknown>>;
  const authentication = record.authentication;
  if (!authentication || typeof authentication !== 'object' || Array.isArray(authentication)) {
    return value;
  }
  const authRecord = authentication as Readonly<Record<string, unknown>>;
  if (
    authRecord.source !== 'connected_service_api_key'
    || !LegacyConnectedServiceBindingSchema.safeParse(authRecord.binding).success
  ) {
    return value;
  }
  return {
    ...record,
    authentication: { source: 'connected_service_api_key' },
  };
}, OpenAiRealtimeSettingsV1CanonicalSchema);

export type OpenAiRealtimeSettingsV1 = z.infer<typeof OpenAiRealtimeSettingsV1Schema>;

export const OPENAI_REALTIME_PROVIDER_ID = 'realtime_openai' as const;
