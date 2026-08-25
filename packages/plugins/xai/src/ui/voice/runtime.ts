import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  RealtimeVoiceProviderRuntime,
  VoiceClientAuthArtifact,
  VoiceConnectionMediaHost,
  VoiceProviderConversationService } from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceRealtimeJsonValue,
} from '@happier-dev/plugin-sdk/voice/client';

import { XAI_VOICE_PROVIDER_CONTRIBUTION_ID } from '../../constants.js';
import { XaiRealtimeSettingsV1Schema } from '../../protocol/voice/settings.js';
import { createXaiWebSocketDriver } from './connection.js';
import type { XaiWebSocketDriverInput } from './connection.js';
import {
  createXaiRealtimeProtocolAdapter,
  createXaiSessionUpdate,
  encodeXaiToolResult,
  type XaiRealtimeClientToolDefinition,
} from './protocol.js';
import { createXaiRealtimeCredentialOperations } from './operations.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toXaiToolDefinitions(
  tools: Parameters<RealtimeVoiceProviderRuntime['createConnection']>[0]['tools'],
): readonly XaiRealtimeClientToolDefinition[] {
  return tools;
}

type VoicePcmConnection = ReturnType<VoiceConnectionMediaHost['createPcmConnection']>;

const CLIENT_AUTH_EXPIRY_SAFETY_WINDOW_MS = 1_000;

function isClientAuthExpired(auth: VoiceClientAuthArtifact): boolean {
  return auth.expiresAtMs <= Date.now() + CLIENT_AUTH_EXPIRY_SAFETY_WINDOW_MS;
}

type CreateXaiConnectionDriver = (input: XaiWebSocketDriverInput) => ReturnType<typeof createXaiWebSocketDriver>;

export function createXaiRealtimeProviderRuntime(options: Readonly<{
  createConnectionDriver?: CreateXaiConnectionDriver;
}> = {}): RealtimeVoiceProviderRuntime {
  const createConnectionDriver = options.createConnectionDriver ?? createXaiWebSocketDriver;
  const credentialOperations = createXaiRealtimeCredentialOperations();
  const providerConversationByPreparationId = new Map<number, Readonly<{
    attemptId: number;
    service: VoiceProviderConversationService;
  }>>();
  let nextPreparationId = 0;
  let activeMedia: Readonly<{
    attemptId: number;
    media: VoicePcmConnection;
  }> | null = null;

  const protocol = createXaiRealtimeProtocolAdapter({
    async preflight({ providerConfig, signal }) {
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
      credentials,
      providerConversation,
      signal,
    }) {
      const parsed = XaiRealtimeSettingsV1Schema.safeParse(providerConfig);
      if (!parsed.success) {
        return { kind: 'declined', code: 'voice_provider_settings_invalid' };
      }
      const settings = parsed.data;
      if (settings.resumptionEnabled && providerConversation === null) {
        return {
          kind: 'declined',
          code: 'xai_resumption_persistence_unavailable',
        };
      }
      const accountOperations = credentials.mediated;
      if (!accountOperations) {
        return {
          kind: 'declined',
          code: 'plugin_voice_credential_access_unavailable',
        };
      }
      const resumableConversation = settings.resumptionEnabled ? providerConversation : null;
      const conversationId = resumableConversation ? await resumableConversation.read() : null;
      if (signal.aborted) return { kind: 'aborted' };
      const auth = await credentialOperations.mintClientAuthWithAccountOperations({
        accountOperations,
        audience: JSON.stringify({ platform: platform === 'web' ? 'web' : 'native' }),
        signal,
      });
      if (signal.aborted) return { kind: 'aborted' };
      if (isClientAuthExpired(auth)) {
        return { kind: 'declined', code: 'voice_auth_expired' };
      }
      const preparationId = ++nextPreparationId;
      if (resumableConversation) {
        providerConversationByPreparationId.set(preparationId, {
          attemptId,
          service: resumableConversation,
        });
      }
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
            model: settings.model.id,
            resumptionEnabled: resumableConversation !== null,
            authExpiresAtMs: auth.expiresAtMs,
          },
          // Only a concrete persisted xAI conversation carries the provider's
          // original response/call identities into this new connection.
          toolResultReplay: conversationId ? 'stable_ids' : 'none',
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
  const settingsOperations: NonNullable<RealtimeVoiceProviderRuntime['settingsOperations']> = Object.freeze({
    async listCatalog({ catalog, credentials, signal }) {
      const accountOperations = credentials.mediated;
      if (!accountOperations) {
        throw Object.assign(
          new Error('plugin_voice_credential_access_unavailable'),
          { code: 'plugin_voice_credential_access_unavailable' },
        );
      }
      return await credentialOperations.fetchCatalogWithAccountOperations({
        accountOperations,
        catalog,
        signal,
      });
    },
  });

  return Object.freeze({
    kind: 'conversation',
    protocol,
    settingsOperations,
    microphoneMode: 'host_pcm',
    outputLevelMeter: 'measured',
    async createConnection({ session, attemptId, media, tools }) {
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
      if (isClientAuthExpired(auth)) {
        throw Object.assign(new Error('voice_auth_expired'), { code: 'voice_auth_expired' });
      }
      const providerConversation = preparedProviderConversation?.service ?? null;
      providerConversationByPreparationId.delete(preparationId);
      let attemptMedia: VoicePcmConnection | null = null;
      const driver = createConnectionDriver({
        auth,
        model,
        conversationId,
        sessionUpdate: createXaiSessionUpdate(settings.data, toXaiToolDefinitions(tools)),
        onConversationId: async (value) => {
          await providerConversation?.write(value);
        },
        // The measured output meter is owned by the host audio scheduler, which
        // is the only party that knows when the buffered tail actually stops
        // being audible. `response.output_audio.done` only says the server
        // finished sending, so it must not move the meter.
        onAudioDelta: (value) => attemptMedia?.enqueueOutput(value) ?? false,
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
      // The host owns fixed-carrier fencing and durable local deletion.
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
    XAI_VOICE_PROVIDER_CONTRIBUTION_ID,
    createXaiRealtimeProviderRuntime(),
  );
}
