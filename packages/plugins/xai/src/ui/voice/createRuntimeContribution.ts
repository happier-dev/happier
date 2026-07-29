import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  VoiceClientAuthArtifact,
  VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type {
  PluginVoicePcmConnection,
  PluginVoiceProviderConversationService,
  PluginVoiceProviderRuntimeRegistration,
} from '@happier-dev/plugin-sdk/runtime';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  XAI_REALTIME_PROVIDER_ID,
  XaiRealtimeSettingsV1Schema,
} from '../../protocol/voice/settings.js';
import { createXaiWebSocketDriver } from './connection.js';
import {
  createXaiRealtimeProtocolAdapter,
  createXaiSessionUpdate,
  encodeXaiToolResult,
  type XaiRealtimeClientToolDefinition,
} from './protocolAdapter.js';
import { createXaiRealtimeCredentialOperations } from './providerOperations.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toXaiToolDefinitions(
  tools: Parameters<PluginVoiceProviderRuntimeRegistration['createConnection']>[0]['tools'],
): readonly XaiRealtimeClientToolDefinition[] {
  return tools;
}

export function createXaiRealtimeProviderRuntimeRegistration(): PluginVoiceProviderRuntimeRegistration {
  const providerId = XAI_REALTIME_PROVIDER_ID;
  const credentialOperations = createXaiRealtimeCredentialOperations();
  const providerConversationByPreparationId = new Map<number, Readonly<{
    attemptId: number;
    service: PluginVoiceProviderConversationService;
  }>>();
  let nextPreparationId = 0;
  let activeMedia: Readonly<{
    attemptId: number;
    media: PluginVoicePcmConnection;
  }> | null = null;
  let lastProviderConversation: PluginVoiceProviderConversationService | null = null;
  let resumptionEnabledForLastPreparation = false;

  const protocol = createXaiRealtimeProtocolAdapter({
    async preflight({ platform, providerConfig, signal }) {
      if (platform !== 'web') {
        return { kind: 'declined', code: 'voice_websocket_pcm_unsupported_platform' };
      }
      if (!XaiRealtimeSettingsV1Schema.safeParse(providerConfig).success) {
        return { kind: 'declined', code: 'voice_provider_settings_invalid' };
      }
      if (signal.aborted) return { kind: 'aborted' };
      return { kind: 'ready' };
    },
    async prepare({
      attemptId,
      platform,
      providerConfig,
      accountOperations,
      providerConversation,
      signal,
    }) {
      if (platform !== 'web') {
        return { kind: 'declined', code: 'voice_websocket_pcm_unsupported_platform' };
      }
      const parsed = XaiRealtimeSettingsV1Schema.safeParse(providerConfig);
      if (!parsed.success) {
        return { kind: 'declined', code: 'voice_provider_settings_invalid' };
      }
      const settings = parsed.data;
      if (settings.resumptionEnabled && providerConversation === null) {
        lastProviderConversation = null;
        resumptionEnabledForLastPreparation = false;
        return {
          kind: 'declined',
          code: 'xai_resumption_persistence_unavailable',
        };
      }
      const resumableConversation = settings.resumptionEnabled ? providerConversation : null;
      const conversationId = resumableConversation ? await resumableConversation.read() : null;
      if (signal.aborted) return { kind: 'aborted' };
      const auth = await credentialOperations.mintClientAuthWithAccountOperations({
        accountOperations,
        audience: JSON.stringify({ platform: 'web' }),
        signal,
      });
      if (signal.aborted) return { kind: 'aborted' };
      if (auth.expiresAtMs <= Date.now() + 1_000) {
        return { kind: 'declined', code: 'voice_auth_expired' };
      }
      const preparationId = ++nextPreparationId;
      if (resumableConversation) {
        providerConversationByPreparationId.set(preparationId, {
          attemptId,
          service: resumableConversation,
        });
      }
      lastProviderConversation = resumableConversation;
      resumptionEnabledForLastPreparation = resumableConversation !== null;
      return {
        kind: 'prepared',
        session: {
          config: {
            auth,
            model: settings.model.id,
            conversationId,
            preparationId,
            settings,
          },
          safeMetadata: {
            providerId,
            model: settings.model.id,
            resumptionEnabled: resumableConversation !== null,
            authExpiresAtMs: auth.expiresAtMs,
          },
        },
      };
    },
    refreshAuth: async () => true,
    releasePrepared({ attemptId }) {
      if (activeMedia?.attemptId === attemptId) activeMedia = null;
      for (const [preparationId, prepared] of providerConversationByPreparationId) {
        if (prepared.attemptId === attemptId) {
          providerConversationByPreparationId.delete(preparationId);
        }
      }
    },
  });

  return Object.freeze({
    protocol,
    outputLevelMeter: 'measured',
    async createConnection({ session, attemptId, media, tools, levels }) {
      const config = record(session.config);
      const settings = XaiRealtimeSettingsV1Schema.safeParse(config?.settings);
      const auth = config?.auth as VoiceClientAuthArtifact | undefined;
      const model = typeof config?.model === 'string' ? config.model : '';
      const conversationId = typeof config?.conversationId === 'string'
        ? config.conversationId
        : null;
      const preparationId = typeof config?.preparationId === 'number'
        && Number.isSafeInteger(config.preparationId)
        && config.preparationId > 0
        ? config.preparationId
        : null;
      if (!settings.success || !auth || !model || !preparationId) {
        throw new Error('voice_websocket_preparation_invalid');
      }
      const preparedProviderConversation =
        providerConversationByPreparationId.get(preparationId) ?? null;
      if (
        preparedProviderConversation
        && preparedProviderConversation.attemptId !== attemptId
      ) {
        throw new Error('voice_websocket_preparation_attempt_mismatch');
      }
      const providerConversation = preparedProviderConversation?.service ?? null;
      providerConversationByPreparationId.delete(preparationId);
      let attemptMedia: PluginVoicePcmConnection | null = null;
      const driver = createXaiWebSocketDriver({
        auth,
        model,
        conversationId,
        sessionUpdate: createXaiSessionUpdate(settings.data, toXaiToolDefinitions(tools)),
        onConversationId: async (value) => {
          await providerConversation?.write(value);
        },
        onAudioDelta: (value) => attemptMedia?.enqueueOutput(value) ?? false,
        onOutputDone: () => levels.onOutputLevel(0),
      });
      attemptMedia = media.createPcmConnection({
        driver,
        input: { sampleRate: 24_000, chunkMs: 100 },
        output: { sampleRate: 24_000, maxBufferedMs: 5_000 },
        onInputChunk: driver.sendAudioChunk,
      });
      activeMedia = Object.freeze({ attemptId, media: attemptMedia });
      return attemptMedia.connection;
    },
    encodeToolResults: (results) => Object.freeze(results.map(encodeXaiToolResult)),
    encodeToolContinuation: () => ({ type: 'response.create' }),
    async beforeToolContinuation(_responseId, signal) {
      await activeMedia?.media.waitForOutputDrain(signal);
    },
    beforeInterrupt() {
      activeMedia?.media.clearOutput();
    },
    encodeContextUpdate: (text) => Object.freeze<readonly VoiceRealtimeJsonValue[]>([{
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[Context update]\n${text}` }],
      },
    }]),
    encodeTextTurn: (text) => Object.freeze<readonly VoiceRealtimeJsonValue[]>([
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      },
      { type: 'response.create' },
    ]),
    async forgetProviderConversation(): Promise<void> {
      if (!resumptionEnabledForLastPreparation) return;
      await lastProviderConversation?.forget();
    },
    dispose() {
      activeMedia = null;
      providerConversationByPreparationId.clear();
    },
  });
}

/** Public executable Voice module entry named by the provider declaration. */
export function activate(api: Pick<PluginApi, 'voiceProviders'>): void {
  api.voiceProviders.register(
    PLUGIN_MANIFEST.contributes.voiceProviders[0].id,
    createXaiRealtimeProviderRuntimeRegistration(),
  );
}
