import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  VoiceClientAuthArtifact,
  VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type {
  PluginVoiceProviderRuntimeRegistration,
} from '@happier-dev/plugin-sdk/runtime';

import {
  OPENAI_REALTIME_PROVIDER_ID,
  OpenAiRealtimeSettingsV1Schema,
} from '../../protocol/voice/settings.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { createOpenAiWebRtcSignaling } from './connection.js';
import {
  createOpenAiRealtimeProtocolAdapter,
  createOpenAiToolSessionUpdate,
  encodeOpenAiRealtimeClientEvent,
  encodeOpenAiToolResult,
  type OpenAiRealtimeClientToolDefinition,
} from './protocolAdapter.js';
import { createOpenAiRealtimeCredentialOperations } from './providerOperations.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createOpenAiRealtimeProviderRuntimeRegistration(
): PluginVoiceProviderRuntimeRegistration {
  const providerId = OPENAI_REALTIME_PROVIDER_ID;
  const preparedAuthByAttemptId = new Map<number, Readonly<{
    attemptId: number;
    preparationId: number;
    auth: VoiceClientAuthArtifact;
  }>>();
  let nextPreparationId = 0;
  const credentialOperations = createOpenAiRealtimeCredentialOperations();

  const protocol = createOpenAiRealtimeProtocolAdapter({
    async preflight({ platform, providerConfig, signal }) {
      if (platform !== 'web') return { kind: 'declined', code: 'voice_webrtc_unsupported_platform' };
      if (!OpenAiRealtimeSettingsV1Schema.safeParse(providerConfig).success) {
        return { kind: 'declined', code: 'voice_provider_settings_invalid' };
      }
      if (signal.aborted) return { kind: 'aborted' };
      return { kind: 'ready' };
    },
    async prepare({ attemptId, platform, providerConfig, accountOperations, signal }) {
      preparedAuthByAttemptId.delete(attemptId);
      if (platform !== 'web') return { kind: 'declined', code: 'voice_webrtc_unsupported_platform' };
      const parsed = OpenAiRealtimeSettingsV1Schema.safeParse(providerConfig);
      if (!parsed.success) {
        return { kind: 'declined', code: 'voice_provider_settings_invalid' };
      }
      const settings = parsed.data;
      const auth = await credentialOperations.mintClientAuthWithAccountOperations({
        accountOperations,
        audience: JSON.stringify({
          model: settings.model.id,
          voice: settings.voice,
          instructions: settings.instructions,
          turnDetection: settings.turnDetection,
          inputTranscriptionModel: settings.inputTranscriptionModel,
        }),
        signal,
      });
      if (signal.aborted) return { kind: 'aborted' };
      if (auth.expiresAtMs <= Date.now() + 1_000) return { kind: 'declined', code: 'voice_auth_expired' };
      const preparationId = ++nextPreparationId;
      preparedAuthByAttemptId.set(
        attemptId,
        Object.freeze({ attemptId, preparationId, auth }),
      );
      return {
        kind: 'prepared',
        session: {
          config: {
            preparationId,
            model: settings.model.id,
          },
          safeMetadata: { providerId, model: settings.model.id, authExpiresAtMs: auth.expiresAtMs },
        },
      };
    },
    refreshAuth: async () => true,
    releasePrepared({ attemptId }) {
      preparedAuthByAttemptId.delete(attemptId);
    },
  });

  return Object.freeze({
    protocol,
    outputLevelMeter: 'unavailable',
    async createConnection({ session, attemptId, media, tools, execution }) {
      const config = record(session.config);
      const preparationId = typeof config?.preparationId === 'number'
        && Number.isSafeInteger(config.preparationId)
        && config.preparationId > 0
        ? config.preparationId
        : null;
      const activePreparedAuth = preparedAuthByAttemptId.get(attemptId);
      if (
        !preparationId
        || activePreparedAuth?.attemptId !== attemptId
        || activePreparedAuth?.preparationId !== preparationId
        || execution.kind !== 'direct_media'
      ) {
        throw new Error('voice_webrtc_preparation_invalid');
      }
      preparedAuthByAttemptId.delete(attemptId);
      const sessionUpdate = createOpenAiToolSessionUpdate(toOpenAiToolDefinitions(tools));
      return media.createWebRtcConnection({
        signaling: createOpenAiWebRtcSignaling({
          ephemeralToken: activePreparedAuth.auth.value,
        }),
        control: {
          label: 'oai-events',
          async onOpen({ sendJson }) {
            await sendJson(sessionUpdate);
          },
        },
      });
    },
    encodeToolResults: (results) => Object.freeze(results.map(encodeOpenAiToolResult)),
    encodeToolContinuation: () => encodeOpenAiRealtimeClientEvent({ type: 'response.create' }),
    // OpenAI requires response.cancel before this WebRTC-only event so already
    // buffered remote audio is cut off as part of an explicit interruption.
    encodePostCancelControls: () => Object.freeze([
      encodeOpenAiRealtimeClientEvent({ type: 'output_audio_buffer.clear' }),
    ]),
    // With provider-side automatic interruption disabled, a VAD stop can race
    // the still-active response. After Happier confirms and cancels the old
    // response, explicitly create the response for the committed user turn.
    encodePostBargeInControls: () => Object.freeze([
      encodeOpenAiRealtimeClientEvent({ type: 'response.create' }),
    ]),
    encodeContextUpdate: (text) => Object.freeze([encodeOpenAiRealtimeClientEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: `[Context update]\n${text}` }],
      },
    })]),
    encodeTextTurn: (text) => Object.freeze([
      encodeOpenAiRealtimeClientEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      }),
      encodeOpenAiRealtimeClientEvent({ type: 'response.create' }),
    ]),
  });
}

function toOpenAiToolDefinitions(
  tools: Parameters<PluginVoiceProviderRuntimeRegistration['createConnection']>[0]['tools'],
): readonly OpenAiRealtimeClientToolDefinition[] {
  return tools;
}

/** Public executable Voice module entry named by the provider declaration. */
export function activate(api: Pick<PluginApi, 'voiceProviders'>): void {
  api.voiceProviders.register(
    PLUGIN_MANIFEST.contributes.voiceProviders[0].id,
    createOpenAiRealtimeProviderRuntimeRegistration(),
  );
}
