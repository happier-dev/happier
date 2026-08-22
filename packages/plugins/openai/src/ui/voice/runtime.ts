import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  RealtimeVoiceProviderRuntime,
  VoiceClientAuthArtifact } from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceRealtimeJsonValue,
} from '@happier-dev/plugin-sdk/voice';

import { OpenAiRealtimeSettingsV1Schema } from '../../protocol/voice/settings.js';
import { OPENAI_VOICE_PROVIDER_CONTRIBUTION_ID } from '../../constants.js';
import {
  createOpenAiWebRtcSignaling,
  OPENAI_CLIENT_AUTH_EXPIRY_SAFETY_WINDOW_MS,
} from './connection.js';
import {
  createOpenAiRealtimeProtocolAdapter,
  createOpenAiToolSessionUpdate,
  encodeOpenAiRealtimeClientEvent,
  encodeOpenAiToolResult,
  type OpenAiRealtimeClientToolDefinition,
} from './protocol.js';
import { createOpenAiRealtimeCredentialOperations } from './operations.js';
import { openAiProviderFetch } from './providerFetch.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function createOpenAiRealtimeProviderRuntime(
): RealtimeVoiceProviderRuntime {
  const preparedAuthByAttemptId = new Map<number, Readonly<{
    attemptId: number;
    preparationId: number;
    auth: VoiceClientAuthArtifact;
    model: string;
    availableForConnection: boolean;
  }>>();
  let nextPreparationId = 0;
  const credentialOperations = createOpenAiRealtimeCredentialOperations();

  const preparedSession = (
    preparation: Readonly<{
      preparationId: number;
      auth: VoiceClientAuthArtifact;
      model: string;
    }>,
  ) => Object.freeze({
    config: Object.freeze({
      preparationId: preparation.preparationId,
      model: preparation.model,
    }),
    safeMetadata: Object.freeze({
      model: preparation.model,
      authExpiresAtMs: preparation.auth.expiresAtMs,
    }),
  });

  const protocol = createOpenAiRealtimeProtocolAdapter({
    async preflight({ providerConfig, signal }) {
      if (!OpenAiRealtimeSettingsV1Schema.safeParse(providerConfig).success) {
        return { kind: 'declined', code: 'voice_provider_settings_invalid' };
      }
      if (signal.aborted) return { kind: 'aborted' };
      return { kind: 'ready' };
    },
    async prepare({ attemptId, reason, providerConfig, credentials, signal }) {
      if (signal.aborted) return { kind: 'aborted' };
      const admitted = preparedAuthByAttemptId.get(attemptId);
      if (reason !== 'initial') {
        // The successful mint is the credential boundary for this exact Voice
        // attempt. Reconnect may reuse only that short-lived authority; it must
        // never consult a newly selected long-lived source. An upstream auth-
        // expired fact cannot be repaired faithfully without rematerializing
        // the original source, so that attempt fails closed and a new Start
        // performs normal source selection.
        if (
          !admitted
          || reason === 'auth_refresh'
          || admitted.auth.expiresAtMs <= Date.now() + OPENAI_CLIENT_AUTH_EXPIRY_SAFETY_WINDOW_MS
        ) {
          preparedAuthByAttemptId.delete(attemptId);
          return { kind: 'declined', code: 'voice_auth_expired' };
        }
        const reconnectPreparation = Object.freeze({
          ...admitted,
          preparationId: ++nextPreparationId,
          availableForConnection: true,
        });
        preparedAuthByAttemptId.set(attemptId, reconnectPreparation);
        return {
          kind: 'prepared',
          session: preparedSession(reconnectPreparation),
        };
      }

      preparedAuthByAttemptId.delete(attemptId);
      const parsed = OpenAiRealtimeSettingsV1Schema.safeParse(providerConfig);
      if (!parsed.success) {
        return { kind: 'declined', code: 'voice_provider_settings_invalid' };
      }
      const settings = parsed.data;
      if (!credentials.mediated) {
        throw Object.assign(new Error('credential_unavailable'), {
          code: 'credential_unavailable',
        });
      }
      const auth = await credentialOperations.mintClientAuthWithAccountOperations({
        accountOperations: credentials.mediated,
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
      if (auth.expiresAtMs <= Date.now() + OPENAI_CLIENT_AUTH_EXPIRY_SAFETY_WINDOW_MS) {
        return { kind: 'declined', code: 'voice_auth_expired' };
      }
      const preparationId = ++nextPreparationId;
      preparedAuthByAttemptId.set(
        attemptId,
        Object.freeze({
          attemptId,
          preparationId,
          auth,
          model: settings.model.id,
          availableForConnection: true,
        }),
      );
      return {
        kind: 'prepared',
        session: preparedSession({
          preparationId,
          auth,
          model: settings.model.id,
        }),
      };
    },
    refreshAuth: async () => false,
    releasePrepared({ attemptId }) {
      preparedAuthByAttemptId.delete(attemptId);
    },
  });

  return Object.freeze({
    kind: 'conversation',
    protocol,
    microphoneMode: 'host_webrtc',
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
        || activePreparedAuth?.availableForConnection !== true
        || execution.kind !== 'direct_media'
      ) {
        throw new Error('voice_webrtc_preparation_invalid');
      }
      if (
        activePreparedAuth.auth.expiresAtMs
        <= Date.now() + OPENAI_CLIENT_AUTH_EXPIRY_SAFETY_WINDOW_MS
      ) {
        preparedAuthByAttemptId.delete(attemptId);
        throw Object.assign(new Error('voice_auth_expired'), {
          code: 'voice_auth_expired',
        });
      }
      preparedAuthByAttemptId.set(attemptId, Object.freeze({
        ...activePreparedAuth,
        availableForConnection: false,
      }));
      const sessionUpdate = createOpenAiToolSessionUpdate(toOpenAiToolDefinitions(tools));
      return media.createWebRtcConnection({
        signaling: createOpenAiWebRtcSignaling({
          ephemeralToken: activePreparedAuth.auth.value,
          expiresAtMs: activePreparedAuth.auth.expiresAtMs,
          fetch: openAiProviderFetch,
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
  tools: Parameters<RealtimeVoiceProviderRuntime['createConnection']>[0]['tools'],
): readonly OpenAiRealtimeClientToolDefinition[] {
  return tools;
}

/** Public executable Voice runtime entry named by the provider declaration. */
export function activate(api: Pick<PluginApi, 'voiceProviders'>): void {
  api.voiceProviders.register(
    OPENAI_VOICE_PROVIDER_CONTRIBUTION_ID,
    createOpenAiRealtimeProviderRuntime(),
  );
}
