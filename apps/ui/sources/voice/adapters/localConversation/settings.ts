import {
  DEFAULT_AGENT_ID,
  PERMISSION_INTENTS,
  parsePermissionIntentAlias,
} from '@happier-dev/agents';
import { ProviderBoundModelRefSchema, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { z } from 'zod';

import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';
import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { VoiceHandsFreeSchema } from '@/voice/adapters/local/settings';

const VoiceLocalConversationProviderChatConfigurationSchema = z.object({
  temperature: z.number().min(0).max(2).nullable().default(null),
}).strict().default({ temperature: null });

export const VoiceLocalConversationProviderChatSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('configured'),
    chat: ProviderBoundModelRefSchema,
    commit: ProviderBoundModelRefSchema,
    configuration: VoiceLocalConversationProviderChatConfigurationSchema,
  }).strict(),
  z.object({
    status: z.literal('needs_selection'),
    providerConnectionId: ProviderConnectionIdSchema,
    chatModelId: z.string().trim().min(1).max(512),
    commitModelId: z.string().trim().min(1).max(512),
    configuration: VoiceLocalConversationProviderChatConfigurationSchema,
  }).strict(),
  z.object({
    status: z.literal('migration_required'),
    reason: z.literal('invalid_legacy_configuration'),
  }).strict(),
]);

export const VoiceLocalConversationSchema = z.object({
  conversationMode: z.enum(['direct_session', 'agent']).default('direct_session'),
  stt: VoiceLocalSttSchema.prefault({}),
  tts: VoiceLocalTtsSchema.prefault({}),
  networkTimeoutMs: z.number().int().min(1000).max(60000).default(15000),
  handsFree: VoiceHandsFreeSchema.prefault({}),
  agent: z
    .object({
      agentSource: z.enum(['session', 'agent']).default('session'),
      agentId: z.string().default(DEFAULT_AGENT_ID),
      // Read-only legacy migration inputs. Canonical machine selection is root-owned.
      machineTargetMode: z.enum(['auto', 'fixed']).default('auto'),
      machineTargetId: z.string().nullable().default(null),
      autoTargetMachineId: z.string().nullable().default(null),
      stayInVoiceHome: z.boolean().default(false),
      teleportEnabled: z.boolean().default(true),
      rootSessionPolicy: z.enum(['single', 'keep_warm']).default('single'),
      maxWarmRoots: z.number().int().min(1).max(10).default(3),
      voiceHomeSubdirName: z.string().default('voice-agent'),
      permissionIntent: z.enum(PERMISSION_INTENTS).default('read-only'),
      idleTtlSeconds: z.number().int().min(60).max(21600).default(1800),
      bootstrapTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
      prewarmOnConnect: z.boolean().default(true),
      resumabilityMode: z.enum(['replay', 'provider_resume']).default('replay'),
      providerResume: z
        .object({ fallbackToReplay: z.boolean().default(true) })
        .default({ fallbackToReplay: true }),
      replay: z
        .object({
          strategy: z.enum(['recent_messages', 'summary_plus_recent']).default('recent_messages'),
          recentMessagesCount: z.number().int().min(1).max(100).default(16),
        })
        .default({ strategy: 'recent_messages', recentMessagesCount: 16 }),
      // Read-only legacy migration input. Canonical welcome is root-owned.
      welcome: z
        .object({
          enabled: z.boolean().default(false),
          mode: z.enum(['immediate', 'on_first_turn']).default('immediate'),
          templateId: z.string().nullable().default(null),
        })
        .default({ enabled: false, mode: 'immediate', templateId: null }),
      commitIsolation: z.boolean().default(false),
      transcript: z
        .object({
          persistenceMode: z.enum(['ephemeral', 'persistent']).default('ephemeral'),
          epoch: z.number().int().min(0).default(0),
        })
        .prefault({}),
      chatModelSource: z.enum(['session', 'custom']).default('custom'),
      chatModelId: z.string().default('default'),
      commitModelSource: z.enum(['chat', 'session', 'custom']).default('chat'),
      commitModelId: z.string().default('default'),
      providerChat: VoiceLocalConversationProviderChatSchema.nullable().default(null),
      verbosity: z.enum(['short', 'balanced']).default('short'),
    })
    .prefault({}),
  streaming: z
    .object({
      enabled: z.boolean().default(true),
      ttsEnabled: z.boolean().default(true),
      ttsChunkChars: z.number().int().min(32).max(2000).default(200),
      turnReadPollIntervalMs: z.number().int().min(10).max(500).default(25),
      turnReadMaxEvents: z.number().int().min(1).max(256).default(64),
      turnStreamTimeoutMs: z.number().int().min(1000).max(3600000).nullable().default(1800000),
    })
    .default({
      enabled: true,
      ttsEnabled: true,
      ttsChunkChars: 200,
      turnReadPollIntervalMs: 25,
      turnReadMaxEvents: 64,
      turnStreamTimeoutMs: 1800000,
    }),
});

export type VoiceLocalConversationSettings = z.infer<typeof VoiceLocalConversationSchema>;

export function stripLegacyLocalConversationOwnership(
  value: VoiceLocalConversationSettings,
): VoiceLocalConversationSettings {
  const agent = value.agent as VoiceLocalConversationSettings['agent'] & Record<string, unknown>;
  const {
    machineTargetMode: _machineTargetMode,
    machineTargetId: _machineTargetId,
    autoTargetMachineId: _autoTargetMachineId,
    welcome: _welcome,
    ...canonicalAgent
  } = agent;
  return { ...value, agent: canonicalAgent as VoiceLocalConversationSettings['agent'] };
}

export function normalizeLegacyLocalConversationInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  const agent = value.agent && typeof value.agent === 'object' && !Array.isArray(value.agent)
    ? value.agent as Record<string, unknown>
    : null;
  const normalizeString = (candidate: unknown): unknown => typeof candidate === 'string' ? candidate.trim() : candidate;
  const networkTimeout = Number(value.networkTimeoutMs);
  const legacyPermissionIntent = typeof agent?.permissionPolicy === 'string'
    ? parsePermissionIntentAlias(agent.permissionPolicy)
    : null;
  const canonicalPermissionIntent = typeof agent?.permissionIntent === 'string'
    ? parsePermissionIntentAlias(agent.permissionIntent)
    : legacyPermissionIntent;
  const {
    permissionPolicy: _legacyPermissionPolicy,
    ...agentWithoutLegacyPermissionPolicy
  } = agent ?? {};
  return {
    ...value,
    ...(Number.isFinite(networkTimeout)
      ? { networkTimeoutMs: Math.max(1000, Math.min(60000, Math.floor(networkTimeout))) }
      : {}),
    ...(agent
      ? {
          agent: {
            ...agentWithoutLegacyPermissionPolicy,
            agentSource: normalizeString(agent.agentSource),
            agentId: normalizeString(agent.agentId),
            machineTargetMode: normalizeString(agent.machineTargetMode),
            machineTargetId: normalizeString(agent.machineTargetId),
            autoTargetMachineId: normalizeString(agent.autoTargetMachineId),
            ...(canonicalPermissionIntent ? { permissionIntent: canonicalPermissionIntent } : {}),
            resumabilityMode: normalizeString(agent.resumabilityMode),
            chatModelSource: normalizeString(agent.chatModelSource),
            commitModelSource: normalizeString(agent.commitModelSource),
            verbosity: normalizeString(agent.verbosity),
          },
        }
      : {}),
  };
}
