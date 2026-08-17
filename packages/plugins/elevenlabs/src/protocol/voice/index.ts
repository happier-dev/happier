import { z } from 'zod';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';
import { SecretStringV1Schema } from '@happier-dev/plugin-sdk/secrets';
import {
  createVoiceRecordSchema,
  VoiceProviderContributionSchema,
  withVoiceSchemaField,
} from '@happier-dev/plugin-sdk/voice';
import { VoiceRealtimeJsonValueSchema } from '@happier-dev/plugin-sdk/voice/client';
import { PLUGIN_MANIFEST } from '../../manifest.js';

export const ELEVENLABS_VOICE_CREDENTIAL_KIND = 'api_key' as const;
const ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION =
  VoiceProviderContributionSchema.parse(
    PLUGIN_MANIFEST.contributes.voiceProviders[0],
  );
if (
  ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION.kind !== 'conversation'
  || ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION.settings === undefined
) {
  throw new Error('invalid_elevenlabs_voice_provider_settings_declaration');
}
export const ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION =
  ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION.settings;

function readDefaultElevenLabsVoiceId(): string {
  const value = ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION.fields
    .find((field) => field.id === 'tts')
    ?.default;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_elevenlabs_voice_provider_default_voice_id');
  }
  const voiceId = value.voiceId;
  if (typeof voiceId !== 'string' || voiceId.length === 0) {
    throw new Error('invalid_elevenlabs_voice_provider_default_voice_id');
  }
  return voiceId;
}

export const DEFAULT_ELEVENLABS_VOICE_ID = readDefaultElevenLabsVoiceId();

export const ElevenLabsAgentIdSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u);
export const ElevenLabsVoiceIdSchema = z.string().trim().min(1).max(256);
export const ElevenLabsModelIdSchema = z.string().trim().min(1).max(256);

const ElevenLabsUnitIntervalSchema = z.number().min(0).max(1);
const ElevenLabsTtsSpeedSchema = z.number().min(0.7).max(1.2);
const ElevenLabsProvisionToolParametersSchema = createVoiceRecordSchema(
  VoiceRealtimeJsonValueSchema,
);

export const ElevenLabsVoiceProviderSettingsLegacySchema = z.object({
  assistantLanguage: z.string().nullable().default(null),
  billingMode: z.enum(['happier', 'byo']).default('happier'),
  welcome: z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(['immediate', 'on_first_turn']).default('immediate'),
    templateId: z.string().nullable().default(null),
  }).default({ enabled: false, mode: 'immediate', templateId: null }),
  tts: z.object({
    voiceId: z.string().default(DEFAULT_ELEVENLABS_VOICE_ID),
    modelId: z.string().nullable().default(null),
    voiceSettings: z.object({
      stability: z.number().min(0).max(1).nullable().default(null),
      similarityBoost: z.number().min(0).max(1).nullable().default(null),
      style: z.number().min(0).max(1).nullable().default(null),
      useSpeakerBoost: z.boolean().nullable().default(null),
      speed: z.number().min(0.5).max(2).nullable().default(null),
    }).prefault({}),
  }).prefault({}),
  byo: z.object({
    agentId: z.string().nullable().default(null),
    apiKey: SecretStringV1Schema.nullable().default(null),
  }).default({ agentId: null, apiKey: null }),
});

export type ElevenLabsVoiceProviderSettings = Readonly<{
  billingMode: 'happier' | 'byo';
  tts: Readonly<{
    voiceId: string;
    modelId: string | null;
    voiceSettings: Readonly<{
      stability: number | null;
      similarityBoost: number | null;
      speed: number | null;
    }>;
  }>;
  agentId: string;
}>;

const validateElevenLabsVoiceProviderSettings = compilePluginJsonSchema({
  type: 'object',
  properties: {
    ...Object.fromEntries(ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION.fields.map(
      (field) => [field.id, field.schema],
    )),
  },
  required: [
    ...ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION.fields.map((field) => field.id),
  ],
  additionalProperties: false,
});

function cloneElevenLabsVoiceProviderSettings(
  value: unknown,
): ElevenLabsVoiceProviderSettings {
  return JSON.parse(JSON.stringify(value)) as ElevenLabsVoiceProviderSettings;
}

/**
 * Runtime parser compiled directly from the public manifest declaration.
 * Missing and unknown fields therefore fail identically in bundled and packed
 * activation paths.
 */
function safeParseElevenLabsVoiceProviderSettings(value: unknown):
  | Readonly<{ success: true; data: ElevenLabsVoiceProviderSettings }>
  | Readonly<{ success: false }> {
  return isValidPluginJsonSchemaValue(validateElevenLabsVoiceProviderSettings, value)
    ? Object.freeze({ success: true as const, data: cloneElevenLabsVoiceProviderSettings(value) })
    : Object.freeze({ success: false as const });
}

export const ElevenLabsVoiceProviderSettingsSchema = Object.freeze({
  safeParse: safeParseElevenLabsVoiceProviderSettings,
  parse(value: unknown): ElevenLabsVoiceProviderSettings {
    const parsed = safeParseElevenLabsVoiceProviderSettings(value);
    if (!parsed.success) throw new Error('invalid_elevenlabs_voice_provider_settings');
    return parsed.data;
  },
});

const parsedElevenLabsVoiceProviderDefaultSettings = ElevenLabsVoiceProviderSettingsSchema.safeParse({
  ...Object.fromEntries(ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION.fields.map(
    (field) => [field.id, field.default],
  )),
});
if (!parsedElevenLabsVoiceProviderDefaultSettings.success) {
  throw new Error('invalid_elevenlabs_voice_provider_settings_defaults');
}
export const ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS =
  parsedElevenLabsVoiceProviderDefaultSettings.data;

export function buildElevenLabsConversationAuthAudience(params: Readonly<{
  agentId: string;
  textOnly: boolean;
}>): string {
  const agentId = ElevenLabsAgentIdSchema.parse(params.agentId);
  return `${params.textOnly ? 'signed_url' : 'conversation_token'}:${agentId}`;
}

export function parseElevenLabsConversationAuthAudience(value: string): Readonly<{
  kind: 'conversation_token' | 'signed_url';
  agentId: string;
}> {
  const match = /^(conversation_token|signed_url):(.+)$/u.exec(value);
  if (!match) throw Object.assign(new Error('invalid_parameters'), { code: 'invalid_parameters' });
  const agentId = ElevenLabsAgentIdSchema.safeParse(match[2]);
  if (!agentId.success) throw Object.assign(new Error('invalid_parameters'), { code: 'invalid_parameters' });
  return Object.freeze({ kind: match[1] as 'conversation_token' | 'signed_url', agentId: agentId.data });
}

const ElevenLabsProvisionToolBaseSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(2_000),
  parameters: z.unknown().nonoptional(),
}).strict();
export const ElevenLabsProvisionToolSchema = withVoiceSchemaField(
  ElevenLabsProvisionToolBaseSchema,
  'parameters',
  ElevenLabsProvisionToolParametersSchema,
);

export const ElevenLabsTtsConfigSchema = z.object({
  voiceId: ElevenLabsVoiceIdSchema,
  modelId: ElevenLabsModelIdSchema.nullable(),
  voiceSettings: z.object({
    stability: ElevenLabsUnitIntervalSchema.nullable(),
    similarityBoost: ElevenLabsUnitIntervalSchema.nullable(),
    speed: ElevenLabsTtsSpeedSchema.nullable(),
  }).strict(),
}).strict();

const ElevenLabsProvisionRequestBaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), tools: z.never().optional() }).strict(),
  z.object({
    kind: z.literal('create'),
    prompt: z.string().min(1).max(100_000),
    tools: z.array(z.unknown()).max(100),
    tts: ElevenLabsTtsConfigSchema,
  }).strict(),
  z.object({
    kind: z.literal('update'),
    agentId: ElevenLabsAgentIdSchema,
    prompt: z.string().min(1).max(100_000),
    tools: z.array(z.unknown()).max(100),
    tts: ElevenLabsTtsConfigSchema,
  }).strict(),
]);
export const ElevenLabsProvisionRequestSchema = withVoiceSchemaField(
  ElevenLabsProvisionRequestBaseSchema,
  'tools',
  ElevenLabsProvisionToolSchema.array(),
);
export type ElevenLabsProvisionRequest = ReturnType<
  typeof ElevenLabsProvisionRequestSchema.parse
>;

export const ElevenLabsProvisionResponseSchema = z.union([
  z.object({ ok: z.literal(true), agents: z.array(z.object({ agentId: ElevenLabsAgentIdSchema, name: z.string().min(1).max(256) }).strict()).max(50) }).strict(),
  z.object({ ok: z.literal(true), agentId: ElevenLabsAgentIdSchema }).strict(),
  z.object({ ok: z.literal(true), updated: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.enum(['invalid_parameters', 'credential_unavailable', 'request_timeout', 'cancelled', 'provider_response_invalid', 'internal_error']) }).strict(),
]);
export type ElevenLabsProvisionResponse = z.infer<typeof ElevenLabsProvisionResponseSchema>;
