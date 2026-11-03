import * as zMini from 'zod/mini';
import { DEFAULT_AGENT_ID } from '../../agents/defaultAgent.js';
import { AGENT_PERMISSION_INTENTS_V1 as PERMISSION_INTENTS, parseAgentPermissionIntentV1Alias as parsePermissionIntentAlias } from '../../runtime/permissionIntentV1.js';
import { BackendTargetKeyV2Schema } from '../../backends/targets/backendTargetRefV2.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';
import { ProviderConnectionIdSchema } from '../../providers/ids.js';
import { ConnectedServiceBindingsV2Schema, type ConnectedServiceBindingsV2 } from '../../connect/connectedServiceBindings.js';
import { z } from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { projectNativeJsonValueForTransport, type JsonValue } from '../../json/strictJsonValue.js';

import { VoiceLocalSttSchema } from './localStt.js';
import { VoiceLocalTtsSchema } from './localTts.js';
import { VoiceHandsFreeSchema } from './handsFree.js';
import { MAX_VOICE_TIMER_DELAY_MS } from './timing.js';

/**
 * Exact target facts of the configured Voice Agent selection. A persisted
 * value the canonical owner refuses is dropped to `null` field-locally — one
 * malformed fact must not void the whole Voice profile — and the selection
 * then keeps resolving through its legacy raw `agentId`.
 */
const VoiceAgentSelectionTargetKeySchema = z._default((<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform((value) => (typeof value === 'string' && BackendTargetKeyV2Schema.safeParse(value).success ? value : null)), z.nullable(z.string())), null);
const VoiceAgentSelectionIdentityValueSchema = zMini.nullable(asProtocolZod(PluginContributionIdentityV1Schema));
const VoiceAgentSelectionIdentitySchema = z._default((<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return PluginContributionIdentityV1Schema.safeParse(value).success ? value : null;
  }), VoiceAgentSelectionIdentityValueSchema), null);
defineStoredReadProjection(VoiceAgentSelectionIdentitySchema, () => z._default((<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = createStoredReadSchema(asProtocolZod(PluginContributionIdentityV1Schema)).safeParse(value);
  return parsed.success ? parsed.data : null;
}), VoiceAgentSelectionIdentityValueSchema), null));

export const VoiceLocalConversationProviderChatSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('configured'),
    chat: ProviderBoundModelRefSchema,
    commit: ProviderBoundModelRefSchema,
  }),
  z.strictObject({
    status: z.literal('needs_selection'),
    providerConnectionId: ProviderConnectionIdSchema,
    chatModelId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    commitModelId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  }),
  z.strictObject({
    status: z.literal('migration_required'),
    reason: z.enum(['invalid_legacy_configuration', 'provider_catalog_import_required']),
  }),
]);

// The JSON projector omits optional undefined members from the already-validated Session shape.
export const VoiceAgentConnectedServicesSchema = z.nullable(z.pipe(ConnectedServiceBindingsV2Schema,
  z.transform(value => projectNativeJsonValueForTransport(value) as ConnectedServiceBindingsV2 & JsonValue)));

export const VoiceLocalConversationSchema = z.object({
  conversationMode: z._default(z.enum(['direct_session', 'agent']), 'direct_session'),
  stt: zMini.prefault(VoiceLocalSttSchema, {}),
  tts: zMini.prefault(VoiceLocalTtsSchema, {}),
  networkTimeoutMs: z._default(z.number().check(z.int(), z.positive(), z.maximum(MAX_VOICE_TIMER_DELAY_MS)), 15000),
  handsFree: zMini.prefault(VoiceHandsFreeSchema, {}),
  agent: z.prefault(z
    .object({
      agentSource: z._default(z.enum(['session', 'agent']), 'session'),
      agentId: z._default(z.string(), DEFAULT_AGENT_ID),
      /**
       * Exact backend target key of the configured Agent, captured at
       * selection time from the one canonical Agent catalog. `null` on
       * selections written before exact facts existed; those keep resolving
       * through the raw `agentId` (legacy bundled behavior).
       */
      agentTargetKey: VoiceAgentSelectionTargetKeySchema,
      /**
       * Qualified external contribution identity of the configured Agent.
       * `null` for bundled Agents, which need no contribution identity.
       */
      agentIdentity: VoiceAgentSelectionIdentitySchema,
      // Absent means the selected Agent's Account defaults, as in New Session.
      connectedServices: z.optional(VoiceAgentConnectedServicesSchema),
      // Read-only legacy migration inputs. Canonical machine selection is root-owned.
      machineTargetMode: z._default(z.enum(['auto', 'fixed']), 'auto'),
      machineTargetId: z._default(z.nullable(z.string()), null),
      autoTargetMachineId: z._default(z.nullable(z.string()), null),
      stayInVoiceHome: z._default(z.boolean(), false),
      teleportEnabled: z._default(z.boolean(), true),
      rootSessionPolicy: z._default(z.enum(['continue', 'new']), 'continue'),
      voiceHomeSubdirName: z._default(z.string(), 'voice-agent'),
      permissionIntent: z._default(z.enum(PERMISSION_INTENTS), 'read-only'),
      idleTtlSeconds: z._default(z.number().check(z.int(), z.positive()), 1800),
      bootstrapTimeoutMs: z._default(z.number().check(z.int(), z.positive()), 60000),
      prewarmOnConnect: z._default(z.boolean(), true),
      resumabilityMode: z._default(z.enum(['replay', 'provider_resume']), 'replay'),
      providerResume: z._default(z
        .object({ fallbackToReplay: z._default(z.boolean(), true) }), { fallbackToReplay: true }),
      replay: z._default(z
        .object({
          strategy: z._default(z.enum(['recent_messages', 'summary_plus_recent']), 'recent_messages'),
          recentMessagesCount: z._default(z.number().check(z.int(), z.positive()), 16),
        }), { strategy: 'recent_messages', recentMessagesCount: 16 }),
      // Read-only legacy migration input. Canonical welcome is root-owned.
      welcome: z._default(z
        .object({
          enabled: z._default(z.boolean(), false),
          mode: z._default(z.enum(['immediate', 'on_first_turn']), 'immediate'),
          templateId: z._default(z.nullable(z.string()), null),
        }), { enabled: false, mode: 'immediate', templateId: null }),
      commitIsolation: z._default(z.boolean(), false),
      transcript: z.prefault(z
        .object({
          persistenceMode: z._default(z.enum(['ephemeral', 'persistent']), 'ephemeral'),
        }), {}),
      chatModelSource: z._default(z.enum(['session', 'custom']), 'custom'),
      chatModelId: z._default(z.string(), 'default'),
      commitModelSource: z._default(z.enum(['chat', 'session', 'custom']), 'chat'),
      commitModelId: z._default(z.string(), 'default'),
      providerChat: z._default(z.nullable(VoiceLocalConversationProviderChatSchema), null),
      verbosity: z._default(z.enum(['short', 'balanced']), 'short'),
    }), {}),
  streaming: z._default(z
    .object({
      enabled: z._default(z.boolean(), true),
      ttsEnabled: z._default(z.boolean(), true),
      ttsChunkChars: z._default(z.number().check(z.int(), z.positive()), 200),
      turnReadPollIntervalMs: z._default(z.number().check(z.int(), z.positive(), z.maximum(MAX_VOICE_TIMER_DELAY_MS)), 25),
      turnReadMaxEvents: z._default(z.number().check(z.int(), z.positive()), 64),
      turnStreamTimeoutMs: z._default(z.nullable(z.number().check(z.int(), z.positive())), 1800000),
    }), {
      enabled: true,
      ttsEnabled: true,
      ttsChunkChars: 200,
      turnReadPollIntervalMs: 25,
      turnReadMaxEvents: 64,
      turnStreamTimeoutMs: 1800000,
    }),
});

export type VoiceLocalConversationSettings = z.infer<typeof VoiceLocalConversationSchema>;

/** An explicit native choice must suppress Account defaults at daemon launch. */
export function projectVoiceAgentConnectedServices(
  agent: Pick<VoiceLocalConversationSettings['agent'], 'connectedServices'>,
): ConnectedServiceBindingsV2 | undefined {
  return agent.connectedServices === null ? { v: 2, bindingsByServiceId: {} } : agent.connectedServices;
}

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
      ? { networkTimeoutMs: Math.max(1, Math.min(MAX_VOICE_TIMER_DELAY_MS, Math.floor(networkTimeout))) }
      : {}),
    ...(agent
      ? {
          agent: {
            ...agentWithoutLegacyPermissionPolicy,
            rootSessionPolicy: agent.rootSessionPolicy === 'single' || agent.rootSessionPolicy === 'keep_warm'
              ? 'continue' : agent.rootSessionPolicy,
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
