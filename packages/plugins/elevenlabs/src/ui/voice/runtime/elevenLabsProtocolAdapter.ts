import {
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type { PluginVoiceProviderProtocol } from '@happier-dev/plugin-sdk/runtime';
import type { PluginVoiceHostedConversationService } from '@happier-dev/plugin-sdk/runtime';

import type { ElevenLabsEventMapper } from './elevenLabsEventMapper.js';
import type { ElevenLabsSessionLifecycle } from './elevenLabsSessionLifecycle.js';
import type { ElevenLabsSessionPreparationService } from './elevenLabsSessionPreparation.js';
import type { ElevenLabsPreparedSession } from './elevenLabsSessionTypes.js';

function readObject(value: VoiceRealtimeJsonValue): Readonly<Record<string, VoiceRealtimeJsonValue>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, VoiceRealtimeJsonValue>>
    : {};
}

function readOptionalString(value: VoiceRealtimeJsonValue | undefined): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

export function createElevenLabsProtocolAdapter(input: Readonly<{
  preparation: ElevenLabsSessionPreparationService;
  lifecycle: ElevenLabsSessionLifecycle;
  eventMapper: ElevenLabsEventMapper;
  onDiagnosticError: (reason: string) => void;
  rememberHostedConversation: (
    leaseId: string,
    service: Pick<PluginVoiceHostedConversationService, 'complete' | 'abort'>,
  ) => void;
}>): Readonly<{
  adapter: PluginVoiceProviderProtocol;
  handleSessionIdentity: (input: Readonly<{
    controlSessionId: string;
    conversationId: string;
  }>) => void;
  endSession: () => Promise<void>;
}> {
  const preparedByAttemptId = new Map<number, Readonly<{
    controlSessionId: string;
    session: ElevenLabsPreparedSession;
  }>>();
  const currentAttemptIdByControlSessionId = new Map<string, number>();

  const adapter: PluginVoiceProviderProtocol = {
    async prepare({
      controlSessionId,
      attemptId,
      request,
      providerConfig,
      accountOperations,
      hostedConversation,
      signal,
    }) {
      const requestRecord = readObject(request);
      const preparation = await input.preparation.prepare({
        controlSessionId,
        initialContext: readOptionalString(requestRecord.initialContext),
        requestedTargetSessionId: readOptionalString(requestRecord.requestedTargetSessionId) ?? null,
        retryAfterPaywall: requestRecord.retryAfterPaywall === true,
        settings: providerConfig,
        accountOperations,
        hostedConversation,
        signal,
        textOnly: requestRecord.textOnly === true,
      });
      if (preparation.kind === 'aborted') return preparation;
      if (preparation.kind === 'declined') {
        input.onDiagnosticError(preparation.error.reason);
        return { kind: 'declined', code: preparation.error.reason };
      }
      let config: VoiceRealtimeJsonValue;
      try {
        config = VoiceRealtimeJsonValueSchema.parse(
          input.preparation.buildStartConfig({
            prepared: preparation.session,
            settings: providerConfig,
          }),
        );
      } catch (error) {
        if (preparation.session.sessionState.billingMode === 'happier') {
          await hostedConversation?.abort();
        }
        throw error;
      }
      input.eventMapper.beginConversation();
      if (preparation.session.sessionState.billingMode === 'happier'
        && preparation.session.sessionState.leaseId
        && hostedConversation) {
        input.rememberHostedConversation(
          preparation.session.sessionState.leaseId,
          hostedConversation,
        );
      }
      input.lifecycle.prepared(attemptId, preparation.session);
      preparedByAttemptId.set(attemptId, {
        controlSessionId,
        session: preparation.session,
      });
      currentAttemptIdByControlSessionId.set(controlSessionId, attemptId);
      const state = preparation.session.sessionState;
      return {
        kind: 'prepared',
        session: {
          config,
          safeMetadata: {
            billingMode: state.billingMode,
            expiresAtMs: state.expiresAtMs,
          },
        },
      };
    },
    decodeControl: (event) => {
      const record = readObject(event);
      const transcript = input.eventMapper.map(event);
      const outputEvent = record.type === 'elevenlabs.mode'
        ? record.mode === 'speaking'
          ? { type: 'assistant_output_started' as const }
          : record.mode === 'listening'
            ? { type: 'assistant_output_stopped' as const }
            : null
        : null;
      return [
        ...(outputEvent ? [outputEvent] : []),
        ...(transcript ? [{ type: 'transcript' as const, event: transcript }] : []),
      ];
    },
    encodeTurnControl: (action) => action === 'stop_session'
      ? { type: 'voice.stop_session' }
      : action === 'send_exact_message'
        ? { type: 'voice.user_text' }
        : null,
    async releasePrepared({ controlSessionId, attemptId }) {
      const prepared = preparedByAttemptId.get(attemptId);
      if (prepared?.controlSessionId !== controlSessionId) return;
      preparedByAttemptId.delete(attemptId);
      if (currentAttemptIdByControlSessionId.get(controlSessionId) === attemptId) {
        currentAttemptIdByControlSessionId.delete(controlSessionId);
      }
      await input.lifecycle.releasePrepared(attemptId, prepared.session);
    },
  };

  return Object.freeze({
    adapter,
    handleSessionIdentity({ controlSessionId, conversationId }) {
      const attemptId = currentAttemptIdByControlSessionId.get(controlSessionId);
      if (attemptId === undefined) return;
      const preparedStart = preparedByAttemptId.get(attemptId);
      if (!preparedStart) return;
      preparedByAttemptId.delete(attemptId);
      currentAttemptIdByControlSessionId.delete(controlSessionId);
      input.lifecycle.started({
        controlSessionId,
        conversationId,
        attemptId,
        prepared: preparedStart.session,
      });
    },
    async endSession() {
      for (const [attemptId, prepared] of preparedByAttemptId) {
        await input.lifecycle.releasePrepared(attemptId, prepared.session);
      }
      preparedByAttemptId.clear();
      currentAttemptIdByControlSessionId.clear();
      await input.lifecycle.ended();
    },
  });
}
