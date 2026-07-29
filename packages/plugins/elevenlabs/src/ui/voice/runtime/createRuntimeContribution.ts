import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  PluginVoiceHostedConversationService,
  PluginVoiceProviderProtocol,
  PluginVoiceProviderSettingsOperations,
  PluginVoiceProviderRuntimeRegistration,
  PluginVoiceRealtimeConnection,
} from '@happier-dev/plugin-sdk/runtime';
import {
  listVoiceSdkSafeToolActionSpecs,
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from '../../../manifest.js';
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  ElevenLabsAgentIdSchema,
  ElevenLabsVoiceProviderSettingsSchema,
} from '../../../protocol/voice/index.js';
import { createElevenLabsAutoprovision } from '../autoprovision.js';
import {
  listElevenLabsVoicesWithAccountOperations,
  provisionElevenLabsWithAccountOperations,
} from '../providerOperations.js';
import { createElevenLabsConversationHandle } from './createElevenLabsConversationHandle.js';
import { createElevenLabsEventMapper } from './elevenLabsEventMapper.js';
import { createElevenLabsProtocolAdapter } from './elevenLabsProtocolAdapter.js';
import { createElevenLabsSdkConnection } from './elevenLabsSdkConnection.js';
import { createElevenLabsSessionLifecycle } from './elevenLabsSessionLifecycle.js';
import { createElevenLabsSessionPreparationService } from './elevenLabsSessionPreparation.js';

const PROVIDER_ID = 'realtime_elevenlabs' as const;

function readControlSessionId(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const dynamicVariables = (config as Readonly<{ dynamicVariables?: unknown }>).dynamicVariables;
  if (!dynamicVariables || typeof dynamicVariables !== 'object' || Array.isArray(dynamicVariables)) return null;
  const value = (dynamicVariables as Readonly<{ sessionId?: unknown }>).sessionId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readProvisionRequest(value: VoiceRealtimeJsonValue): Readonly<{
  kind: 'list' | 'create' | 'update';
  agentId?: string;
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_parameters');
  }
  const record = value as Readonly<Record<string, VoiceRealtimeJsonValue>>;
  if (record.kind === 'list' || record.kind === 'create') return Object.freeze({ kind: record.kind });
  const agentId = ElevenLabsAgentIdSchema.safeParse(record.agentId);
  if (record.kind !== 'update' || !agentId.success) throw new Error('invalid_parameters');
  return Object.freeze({ kind: 'update', agentId: agentId.data });
}

/**
 * Public ElevenLabs leaf. All app authority arrives through attempt-scoped
 * Plugin SDK inputs; activation itself has no private host parameter.
 */
export function createElevenLabsVoiceProviderRuntimeRegistration():
PluginVoiceProviderRuntimeRegistration {
  const preparation = createElevenLabsSessionPreparationService({
    providerId: PROVIDER_ID,
    projectVoiceSettings(settings) {
      return Object.freeze({
        providerId: PROVIDER_ID,
        assistantLanguage: null,
        welcome: Object.freeze({ enabled: false, mode: 'immediate' as const }),
        providerConfig: settings,
      });
    },
    // Subscription denial remains an explicit protocol result. A public leaf
    // cannot invoke app-private modal or translation services.
    presentPaywall: async () => Object.freeze({ purchased: false }),
    alert() {},
    createMachineError: (input) => Object.freeze({
      ...input,
      phase: 'runtime' as const,
      retryPolicy: 'user_action' as const,
      recoveryAction: input.kind === 'provider_auth_invalid'
        ? 'review_credentials' as const
        : 'retry' as const,
      presentation: 'error' as const,
      recoverable: true,
    }),
  });
  const hostedConversationsByLeaseId = new Map<
    string,
    Pick<PluginVoiceHostedConversationService, 'complete' | 'abort'>
  >();
  const lifecycle = createElevenLabsSessionLifecycle({
    takeHostedConversation(leaseId) {
      const service = hostedConversationsByLeaseId.get(leaseId) ?? null;
      hostedConversationsByLeaseId.delete(leaseId);
      return service;
    },
  });
  const provider = createElevenLabsProtocolAdapter({
    preparation,
    lifecycle,
    eventMapper: createElevenLabsEventMapper(),
    onDiagnosticError() {},
    rememberHostedConversation(leaseId, service) {
      hostedConversationsByLeaseId.set(leaseId, service);
    },
  });
  const protocol: PluginVoiceProviderProtocol = Object.freeze({
    prepare: provider.adapter.prepare,
    decodeControl: provider.adapter.decodeControl,
    encodeTurnControl: provider.adapter.encodeTurnControl,
    ...(provider.adapter.releasePrepared
      ? { releasePrepared: provider.adapter.releasePrepared }
      : {}),
  });
  let activeConnection: PluginVoiceRealtimeConnection | null = null;
  let activeHandle: ReturnType<typeof createElevenLabsConversationHandle> | null = null;
  let disposed = false;
  const settingsOperations: PluginVoiceProviderSettingsOperations = Object.freeze({
    async listCatalog({ catalog, accountOperations, signal }) {
      signal.throwIfAborted();
      if (catalog !== 'voices') throw new Error('unsupported_voice_catalog');
      const voices = await listElevenLabsVoicesWithAccountOperations({
        accountOperations,
        signal,
      });
      signal.throwIfAborted();
      return Object.freeze(voices.map((voice) => VoiceRealtimeJsonValueSchema.parse(voice)));
    },
    async provision({
      request,
      providerConfig,
      disabledActionIds,
      extraSystemAppendBlocks,
      accountOperations,
      signal,
    }) {
      signal.throwIfAborted();
      const config = ElevenLabsVoiceProviderSettingsSchema.safeParse(providerConfig);
      if (!config.success) throw new Error('invalid_parameters');
      const operation = readProvisionRequest(request);
      const disabled = new Set(disabledActionIds);
      const autoprovision = createElevenLabsAutoprovision({
        defaultVoiceId: DEFAULT_ELEVENLABS_VOICE_ID,
        client: Object.freeze({
          async provision(provisionRequest, operationSignal) {
            return await provisionElevenLabsWithAccountOperations({
              accountOperations,
              request: provisionRequest,
              signal: operationSignal,
            });
          },
        }),
        async buildContext() {
          signal.throwIfAborted();
          return Object.freeze({
            disabledActionIds,
            extraSystemAppendBlocks,
            actionSpecs: listVoiceSdkSafeToolActionSpecs().filter((spec) => !disabled.has(spec.id)),
          });
        },
      });
      const tts = config.data.tts;
      if (operation.kind === 'list') {
        return VoiceRealtimeJsonValueSchema.parse({
          agents: await autoprovision.findExistingAgents(signal),
        });
      }
      if (operation.kind === 'create') {
        return VoiceRealtimeJsonValueSchema.parse(await autoprovision.createAgent({ tts }, signal));
      }
      await autoprovision.updateAgent({ agentId: operation.agentId!, tts }, signal);
      return Object.freeze({ updated: true });
    },
  });

  return Object.freeze({
    protocol,
    settingsOperations,
    // The ElevenLabs SDK exclusively owns capture and playback. The host still
    // owns the canonical audio-mode lease and the only Voice session lifecycle.
    requiresMicForConnection: false,
    outputLevelMeter: 'unavailable',
    async createConnection({ session, mic, media, tools, execution }) {
      if (disposed) throw new Error('elevenlabs_runtime_disposed');
      if (execution.kind !== 'direct_media') {
        throw new Error('elevenlabs_direct_media_authority_required');
      }
      const executableTools = tools.map((tool) => {
        const executable = tool as typeof tool & Readonly<{
          execute(parameters: import('@happier-dev/protocol').VoiceRealtimeJsonValue):
            Promise<import('@happier-dev/protocol').VoiceRealtimeJsonValue>;
        }>;
        if (typeof executable.execute !== 'function') {
          throw new Error(`elevenlabs_voice_tool_executor_missing:${tool.name}`);
        }
        return executable;
      });
      const handle = createElevenLabsConversationHandle({ tools: executableTools });
      activeHandle?.dispose();
      activeHandle = handle;
      const controlSessionId = readControlSessionId(session.config);
      const connection = createElevenLabsSdkConnection({
        createSdkHandleConnection: media.createSdkHandleConnection,
        handle,
        startConfig: session.config,
        initialMuted: mic.isMuted(),
        onSessionIdentity(conversationId) {
          if (controlSessionId) provider.handleSessionIdentity({ controlSessionId, conversationId });
        },
        onSessionEnded: provider.endSession,
      });
      activeConnection = connection;
      return connection;
    },
    setInputMuted(muted) {
      activeHandle?.setMicMuted(muted);
    },
    // ElevenLabs executes host-owned attempt tools inside the SDK handle and
    // therefore never emits host tool-call events into this barrier path.
    encodeToolResults: () => Object.freeze([]),
    encodeToolContinuation: () => Object.freeze({ type: 'voice.provider_managed_tools' }),
    encodeContextUpdate: (text) => Object.freeze([{ type: 'voice.context_update', text }]),
    encodeTextTurn: (text) => Object.freeze([{ type: 'voice.user_text', text }]),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await activeConnection?.close({ code: 'replaced' }).catch(() => {});
      activeConnection = null;
      await provider.endSession();
      hostedConversationsByLeaseId.clear();
      activeHandle?.dispose();
      activeHandle = null;
    },
  });
}

export function activate(api: Pick<PluginApi, 'voiceProviders'>): void {
  api.voiceProviders.register(
    PLUGIN_MANIFEST.contributes.voiceProviders[0].id,
    createElevenLabsVoiceProviderRuntimeRegistration(),
  );
}
