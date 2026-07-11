import {
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';

import type { ProtocolAdapter } from './types.js';
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
  getSettings: () => unknown;
}>): Readonly<{
  adapter: ProtocolAdapter;
  handleSessionIdentity: (input: Readonly<{
    controlSessionId: string;
    conversationId: string;
  }>) => void;
  endSession: () => Promise<void>;
}> {
  const preparedByControlSessionId = new Map<string, ElevenLabsPreparedSession>();

  const adapter: ProtocolAdapter = {
    id: 'realtime_elevenlabs',
    turnControls: {
      cancelResponse: 'unsupported',
      truncatePlayback: 'unsupported',
      clearInput: false,
      stopSession: true,
      resumption: 'none',
      replay: 'none',
      exactMessage: true,
    },
    async prepare({ controlSessionId, request, signal }) {
      const requestRecord = readObject(request);
      const settings = input.getSettings();
      const preparation = await input.preparation.prepare({
        controlSessionId,
        initialContext: readOptionalString(requestRecord.initialContext),
        requestedTargetSessionId: readOptionalString(requestRecord.requestedTargetSessionId) ?? null,
        retryAfterPaywall: requestRecord.retryAfterPaywall === true,
        settings,
        signal,
        textOnly: requestRecord.textOnly === true,
      });
      if (preparation.kind === 'aborted') return preparation;
      if (preparation.kind === 'declined') {
        input.onDiagnosticError(preparation.error.reason);
        return { kind: 'declined', code: preparation.error.reason };
      }
      input.eventMapper.beginConversation();
      preparedByControlSessionId.set(controlSessionId, preparation.session);
      const config = VoiceRealtimeJsonValueSchema.parse(
        input.preparation.buildStartConfig({
          prepared: preparation.session,
          settings,
        }),
      );
      const state = preparation.session.sessionState;
      return {
        kind: 'prepared',
        session: {
          config,
          safeMetadata: {
            billingMode: state.billingMode,
            expiresAtMs: state.expiresAtMs,
            leaseId: state.leaseId,
          },
        },
      };
    },
    decodeControl: (event) => {
      const transcript = input.eventMapper.map(event);
      return transcript
        ? [{ type: 'provider_event', event }, { type: 'transcript', event: transcript }]
        : [{ type: 'provider_event', event }];
    },
    encodeTurnControl: (action) => action === 'stop_session'
      ? { type: 'voice.stop_session' }
      : action === 'send_exact_message'
        ? { type: 'voice.user_text' }
        : null,
    releasePrepared: ({ controlSessionId }) => {
      preparedByControlSessionId.delete(controlSessionId);
    },
  };

  return Object.freeze({
    adapter,
    handleSessionIdentity({ controlSessionId, conversationId }) {
      const preparedStart = preparedByControlSessionId.get(controlSessionId);
      if (!preparedStart) return;
      preparedByControlSessionId.delete(controlSessionId);
      input.lifecycle.started({ controlSessionId, conversationId, prepared: preparedStart });
    },
    async endSession() {
      preparedByControlSessionId.clear();
      await input.lifecycle.ended();
    },
  });
}
