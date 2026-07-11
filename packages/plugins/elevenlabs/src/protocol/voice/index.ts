import { z } from 'zod';
import { SecretStringV1Schema } from '@happier-dev/protocol';
import type { VoiceConversationProviderDescriptorV1 } from '@happier-dev/protocol';

export const ELEVENLABS_VOICE_PROVIDER_ID = 'realtime_elevenlabs' as const;
export const ELEVENLABS_VOICE_CREDENTIAL_KIND = 'api_key' as const;
export const DEFAULT_ELEVENLABS_VOICE_ID = 'EST9Ui6982FZPSi7gCHi' as const;

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

export const ElevenLabsVoiceProviderSettingsSchema = ElevenLabsVoiceProviderSettingsLegacySchema.omit({
  assistantLanguage: true,
  welcome: true,
}).extend({
  byo: z.object({
    agentId: z.string().nullable().default(null),
  }).strict().default({ agentId: null }),
});
export type ElevenLabsVoiceProviderSettings = z.infer<typeof ElevenLabsVoiceProviderSettingsSchema>;

const ElevenLabsAgentIdSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u);

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

export type ElevenLabsVoiceUiEntry = VoiceConversationProviderDescriptorV1 & Readonly<{
  pluginId: 'happier.voice.elevenlabs';
  providerId: 'realtime_elevenlabs';
}>;

export const ElevenLabsProvisionToolSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(2_000),
  parameters: z.record(z.string(), z.unknown()),
}).strict();

export const ElevenLabsTtsConfigSchema = z.object({
  voiceId: z.string().trim().min(1).max(256),
  modelId: z.string().trim().min(1).max(256).nullable(),
  voiceSettings: z.object({
    stability: z.number().min(0).max(1).nullable(),
    similarityBoost: z.number().min(0).max(1).nullable(),
    style: z.number().min(0).max(1).nullable(),
    useSpeakerBoost: z.boolean().nullable(),
    speed: z.number().min(0.7).max(1.2).nullable(),
  }).strict(),
}).strict();

export const ElevenLabsProvisionRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list') }).strict(),
  z.object({
    kind: z.literal('create'),
    prompt: z.string().min(1).max(100_000),
    tools: z.array(ElevenLabsProvisionToolSchema).max(100),
    tts: ElevenLabsTtsConfigSchema,
  }).strict(),
  z.object({
    kind: z.literal('update'),
    agentId: ElevenLabsAgentIdSchema,
    prompt: z.string().min(1).max(100_000),
    tools: z.array(ElevenLabsProvisionToolSchema).max(100),
    tts: ElevenLabsTtsConfigSchema,
  }).strict(),
]);
export type ElevenLabsProvisionRequest = z.infer<typeof ElevenLabsProvisionRequestSchema>;

export const ElevenLabsProvisionResponseSchema = z.union([
  z.object({ ok: z.literal(true), agents: z.array(z.object({ agentId: ElevenLabsAgentIdSchema, name: z.string().min(1).max(256) }).strict()).max(50) }).strict(),
  z.object({ ok: z.literal(true), agentId: ElevenLabsAgentIdSchema }).strict(),
  z.object({ ok: z.literal(true), updated: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.enum(['invalid_parameters', 'credential_unavailable', 'request_timeout', 'cancelled', 'provider_response_invalid', 'internal_error']) }).strict(),
]);
export type ElevenLabsProvisionResponse = z.infer<typeof ElevenLabsProvisionResponseSchema>;
