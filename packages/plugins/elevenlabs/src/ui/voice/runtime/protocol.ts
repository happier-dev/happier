import {
  VoiceRealtimeJsonValueSchema,
  VoiceRealtimeToolCallV1Schema,
  type VoiceRealtimeJsonValue,
  RealtimeVoiceProviderProtocol,
  VoiceHostedConversationService,
} from '@happier-dev/plugin-sdk/voice/client';

import type { ElevenLabsEventMapper } from './eventMapper.js';
import type { ElevenLabsSessionLifecycle } from './sessionLifecycle.js';
import type { ElevenLabsSessionPreparationService } from './sessionPreparation.js';
import type { ElevenLabsPreparedSession } from './sessionTypes.js';

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
    service: Pick<VoiceHostedConversationService, 'complete' | 'abort'>,
  ) => void;
}>): Readonly<{
  adapter: RealtimeVoiceProviderProtocol;
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

  const releasePreparedAttempt = async (
    controlSessionId: string,
    attemptId: number,
  ): Promise<void> => {
    const prepared = preparedByAttemptId.get(attemptId);
    if (prepared && prepared.controlSessionId !== controlSessionId) return;
    await input.lifecycle.releasePrepared(attemptId, prepared?.session);
    preparedByAttemptId.delete(attemptId);
    if (currentAttemptIdByControlSessionId.get(controlSessionId) === attemptId) {
      currentAttemptIdByControlSessionId.delete(controlSessionId);
    }
  };

  const adapter: RealtimeVoiceProviderProtocol = {
    async prepare({
      controlSessionId,
      attemptId,
      request,
      platform,
      providerConfig,
      credentials,
      hostedConversation,
      attemptPolicy,
      signal,
    }) {
      const priorAttemptId = currentAttemptIdByControlSessionId.get(controlSessionId);
      if (priorAttemptId !== undefined) {
        await releasePreparedAttempt(controlSessionId, priorAttemptId);
      }
      input.lifecycle.preparing(attemptId, hostedConversation);
      const requestRecord = readObject(request);
      const preparation = await input.preparation.prepare({
        controlSessionId,
        initialContext: readOptionalString(requestRecord.initialContext),
        requestedTargetSessionId: readOptionalString(requestRecord.requestedTargetSessionId) ?? null,
        settings: providerConfig,
        ...(attemptPolicy ? { attemptPolicy } : {}),
        credentials,
        hostedConversation,
        signal,
        platform,
        textOnly: requestRecord.textOnly === true,
      });
      if (preparation.kind === 'aborted') return preparation;
      if (preparation.kind === 'declined') {
        input.onDiagnosticError(preparation.failure.reason);
        return { kind: 'declined', code: preparation.failure.reason };
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
          initialContextDelivery: 'prepared',
          safeMetadata: {
            billingMode: state.billingMode,
            expiresAtMs: state.expiresAtMs,
          },
        },
      };
    },
    decodeControl: (event) => {
      const record = readObject(event);
      if (record.type === 'elevenlabs.client_tool_call') {
        const call = VoiceRealtimeToolCallV1Schema.parse(record.call);
        return [{ type: 'tool_calls', responseId: call.responseId, calls: [call] }];
      }
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
    encodeTurnControl: (action, payload) => {
      if (action === 'stop_session') {
        return VoiceRealtimeJsonValueSchema.parse({ type: 'voice.stop_session' });
      }
      if (action !== 'send_exact_message') return null;
      const text = readObject(payload ?? null).text;
      return typeof text === 'string' && text.trim()
        ? VoiceRealtimeJsonValueSchema.parse({ type: 'voice.user_text', text })
        : null;
    },
    async releasePrepared({ controlSessionId, attemptId }) {
      await releasePreparedAttempt(controlSessionId, attemptId);
    },
  };

  return Object.freeze({
    adapter,
    handleSessionIdentity({ controlSessionId, conversationId }) {
      const attemptId = currentAttemptIdByControlSessionId.get(controlSessionId);
      if (attemptId === undefined) return;
      const preparedStart = preparedByAttemptId.get(attemptId);
      if (!preparedStart) return;
      input.lifecycle.started({
        controlSessionId,
        conversationId,
        attemptId,
        prepared: preparedStart.session,
      });
    },
    async endSession() {
      await input.lifecycle.ended();
      for (const [attemptId, prepared] of preparedByAttemptId) {
        await releasePreparedAttempt(prepared.controlSessionId, attemptId);
      }
      preparedByAttemptId.clear();
      currentAttemptIdByControlSessionId.clear();
    },
  });
}
