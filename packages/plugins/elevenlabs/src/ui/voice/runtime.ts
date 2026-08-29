import type { PluginApi } from '@happier-dev/plugin-sdk';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import type {
  PluginSettingsActionInput,
  PluginSettingsActionRuntime,
} from '@happier-dev/plugin-sdk/settings';
import type {
  VoiceCredentialAccess,
  VoiceSettingsActionContext,
} from '@happier-dev/plugin-sdk/voice';
import {
  VoiceRealtimeJsonValueSchema,
  type RealtimeVoiceProviderProtocol,
  type RealtimeVoiceProviderRuntime,
  type RealtimeVoiceProviderSettingsOperations,
  type VoiceHostedConversationService,
  type VoiceRealtimeJsonValue,
  type VoiceRealtimeConnection,
} from '@happier-dev/plugin-sdk/voice/client';

import { ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION_ID } from '../../constants.js';
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  ElevenLabsAgentIdSchema,
  ElevenLabsVoiceProviderSettingsSchema,
} from '../../protocol/voice/index.js';
import { createElevenLabsAutoprovision } from './autoprovision.js';
import {
  listElevenLabsVoicesWithAccountOperations,
  provisionElevenLabsWithAccountOperations,
} from './operations.js';
import { createElevenLabsConversationHandle } from './runtime/conversationHandle.js';
import { createElevenLabsEventMapper } from './runtime/eventMapper.js';
import { createElevenLabsProtocolAdapter } from './runtime/protocol.js';
import { createElevenLabsSdkConnection } from './runtime/sdkConnection.js';
import { createElevenLabsSessionLifecycle } from './runtime/sessionLifecycle.js';
import { createElevenLabsSessionPreparationService } from './runtime/sessionPreparation.js';

const PROVIDER_ID = ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION_ID;
const EXISTING_AGENT_ACTION_QUESTION_ID = 'existing-agent-action';

function settingsActionInteractionError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function readControlSessionId(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const dynamicVariables = (config as Readonly<{ dynamicVariables?: unknown }>).dynamicVariables;
  if (!dynamicVariables || typeof dynamicVariables !== 'object' || Array.isArray(dynamicVariables)) return null;
  const value = (dynamicVariables as Readonly<{ sessionId?: unknown }>).sessionId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireMediatedCredentials<P extends 'settings' | 'prepare'>(
  credentials: VoiceCredentialAccess<P>,
) {
  if (!credentials.mediated) {
    throw Object.assign(new Error('voice_provider_credential_unavailable'), {
      code: 'plugin_voice_credential_access_unavailable',
    });
  }
  return credentials.mediated;
}

function parseSettingsSnapshot(input: PluginSettingsActionInput) {
  return ElevenLabsVoiceProviderSettingsSchema.parse(input.settings);
}

/**
 * Public ElevenLabs leaf. All app authority arrives through attempt-scoped
 * Plugin SDK inputs; activation itself has no private host parameter.
 */
export function createElevenLabsVoiceProviderRuntime():
RealtimeVoiceProviderRuntime & Readonly<{
  settingsActions: PluginSettingsActionRuntime<VoiceSettingsActionContext>;
}> {
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
    alert() {},
  });
  const hostedConversationsByLeaseId = new Map<
    string,
    Pick<VoiceHostedConversationService, 'complete' | 'abort'>
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
  const protocol: RealtimeVoiceProviderProtocol = Object.freeze({
    prepare: provider.adapter.prepare,
    decodeControl: provider.adapter.decodeControl,
    encodeTurnControl: provider.adapter.encodeTurnControl,
    ...(provider.adapter.releasePrepared
      ? { releasePrepared: provider.adapter.releasePrepared }
      : {}),
  });
  let activeConnection: VoiceRealtimeConnection | null = null;
  let activeHandle: ReturnType<typeof createElevenLabsConversationHandle> | null = null;
  let inputMuted = false;
  let disposed = false;
  const settingsOperations: RealtimeVoiceProviderSettingsOperations = Object.freeze({
    async listCatalog({ catalog, credentials, signal }) {
      throwIfAborted(signal);
      if (catalog !== 'voices') throw new Error('unsupported_voice_catalog');
      const voices = await listElevenLabsVoicesWithAccountOperations({
        accountOperations: requireMediatedCredentials(credentials),
        signal,
      });
      throwIfAborted(signal);
      return Object.freeze(voices.map((voice) => VoiceRealtimeJsonValueSchema.parse(voice)));
    },
  });
  const settingsActions = Object.freeze({
    async execute(
      input: PluginSettingsActionInput,
      context: VoiceSettingsActionContext,
    ) {
      throwIfAborted(context.signal);
      const config = parseSettingsSnapshot(input);
      const accountOperations = requireMediatedCredentials(context.credentials);
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
        tools: context.tools,
      });
      if (input.actionId === 'create-agent') {
        const existingAgents = await autoprovision.findExistingAgents(context.signal);
        if (existingAgents.length > 0) {
          const choices = [
            {
              id: 'create-new',
              label: 'Create a new agent',
              description: 'Keep every existing Happier Voice agent unchanged.',
            },
            ...existingAgents.map((agent, index) => ({
              id: `update-existing-${index}`,
              label: `Update ${agent.name}`,
              description: `Agent ID: ${agent.agentId}`,
            })),
          ] as [
            { id: string; label: string; description: string },
            ...Array<{ id: string; label: string; description: string }>,
          ];
          const interaction = await context.interactions.askQuestions({
            kind: 'questions',
            title: 'Existing Happier Voice agent',
            questions: [Object.freeze({
              id: EXISTING_AGENT_ACTION_QUESTION_ID,
              prompt: existingAgents.length === 1
                ? 'A Happier Voice agent already exists. What would you like to do?'
                : 'Happier Voice agents already exist. What would you like to do?',
              type: 'singleChoice' as const,
              required: true,
              choices,
            })],
          }, { signal: context.signal });
          throwIfAborted(context.signal);
          if (interaction.status !== 'answered') {
            throw settingsActionInteractionError(
              interaction.status === 'unavailable'
                ? 'plugin_settings_action_interaction_unavailable'
                : 'plugin_settings_action_cancelled',
            );
          }
          const answer = interaction.answers[EXISTING_AGENT_ACTION_QUESTION_ID];
          if (answer?.kind !== 'singleChoice' || answer.answer.kind !== 'choice') {
            throw settingsActionInteractionError('plugin_settings_action_interaction_invalid');
          }
          if (answer.answer.choiceId !== 'create-new') {
            const match = /^update-existing-(\d+)$/u.exec(answer.answer.choiceId);
            const selectedIndex = match ? Number(match[1]) : Number.NaN;
            const selected = Number.isSafeInteger(selectedIndex)
              ? existingAgents[selectedIndex]
              : undefined;
            if (!selected) {
              throw settingsActionInteractionError('plugin_settings_action_interaction_invalid');
            }
            await autoprovision.updateAgent({
              agentId: selected.agentId,
              tts: config.tts,
            }, context.signal);
            return Object.freeze({ patch: Object.freeze({ agentId: selected.agentId }) });
          }
        }
        const result = await autoprovision.createAgent({ tts: config.tts }, context.signal);
        return Object.freeze({ patch: Object.freeze({ agentId: result.agentId }) });
      }
      if (input.actionId === 'update-agent') {
        const agentId = ElevenLabsAgentIdSchema.parse(config.agentId);
        await autoprovision.updateAgent({ agentId, tts: config.tts }, context.signal);
        return Object.freeze({ patch: Object.freeze({ agentId }) });
      }
      throw Object.assign(new Error('invalid_parameters'), { code: 'invalid_parameters' });
    },
  });

  return Object.freeze({
    kind: 'conversation' as const,
    protocol,
    settingsOperations,
    settingsActions,
    // The ElevenLabs SDK exclusively owns capture and playback. The host still
    // owns the canonical audio-mode lease and the only Voice session lifecycle.
    microphoneMode: 'provider_managed',
    outputLevelMeter: 'unavailable',
    async createConnection({ session, media, tools, execution, interruption }) {
      if (disposed) throw new Error('elevenlabs_runtime_disposed');
      if (execution.kind !== 'direct_media') {
        throw new Error('elevenlabs_direct_media_authority_required');
      }
      const executableTools = tools.map((tool) => {
        const executable = tool as typeof tool & Readonly<{
          execute(parameters: VoiceRealtimeJsonValue): Promise<VoiceRealtimeJsonValue>;
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
        // Read at connection startup rather than construction: an interruption
        // can change the runtime-owned desired mute between those boundaries.
        // Once startup begins, the handle retains every later update itself.
        initialMuted: () => inputMuted,
        duckGain: interruption.duckGain,
        onSessionIdentity(conversationId) {
          if (controlSessionId) provider.handleSessionIdentity({ controlSessionId, conversationId });
        },
        onSessionEnded: provider.endSession,
      });
      activeConnection = connection;
      return connection;
    },
    setInputMuted(muted) {
      inputMuted = muted;
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
    PROVIDER_ID,
    createElevenLabsVoiceProviderRuntime(),
  );
}
