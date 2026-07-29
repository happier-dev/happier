import {
  DaemonVoiceInferenceTtsStreamAckRequestSchema,
  DaemonVoiceInferenceTtsStreamAckResponseSchema,
  DaemonVoiceInferenceTtsStreamCancelRequestSchema,
  DaemonVoiceInferenceTtsStreamCancelResponseSchema,
  DaemonVoiceInferenceTtsStreamNextRequestSchema,
  DaemonVoiceInferenceTtsStreamNextResponseSchema,
  DaemonVoiceInferenceTtsStreamStartRequestSchema,
  DaemonVoiceInferenceTtsStreamStartResponseSchema,
  DaemonVoiceInferenceTtsStreamStatusRequestSchema,
  DaemonVoiceInferenceTtsStreamStatusResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  createVoiceInferenceTtsSegmentManager,
  type VoiceInferenceTtsSegmentWorker,
} from '@/daemon/voiceInference/streaming/tts/voiceInferenceTtsSegmentManager';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { VoiceDiagnosticsController } from '@/daemon/voiceDiagnostics/controller';

import {
  parseVoiceInferenceResponse,
  toVoiceInferenceError,
  type VoiceInferenceSchemaParser,
} from './voiceInferenceRpcResponses';

function invalidParameters<T>(schema: VoiceInferenceSchemaParser<T>): T {
  return parseVoiceInferenceResponse(schema, toVoiceInferenceError(new Error('invalid_parameters')));
}

export type MachineVoiceInferenceTtsStreamingRpcRegistration = Readonly<{
  dispose: () => Promise<void>;
}>;

export function registerMachineVoiceInferenceTtsStreamingRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  voiceInferenceWorker: VoiceInferenceTtsSegmentWorker;
  voiceDiagnostics?: Pick<VoiceDiagnosticsController, 'capture'>;
  streamRoot?: string;
}>): MachineVoiceInferenceTtsStreamingRpcRegistration {
  const manager = createVoiceInferenceTtsSegmentManager({
    voiceInferenceWorker: params.voiceInferenceWorker,
    ...(params.streamRoot ? { streamRoot: params.streamRoot } : {}),
  });
  const diagnosticContextByStreamId = new Map<string, Readonly<{
    sessionId: string;
    providerId: string;
    requestId: string;
    authorizationId?: string;
    pendingSegments: Map<string, Buffer>;
  }>>();

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsStreamStartRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceTtsStreamStartResponseSchema);
    }
    const response = parseVoiceInferenceResponse(
      DaemonVoiceInferenceTtsStreamStartResponseSchema,
      await manager.start(parsed.data),
    );
    if (response.ok && parsed.data.diagnostics?.captureAllowed === true) {
      diagnosticContextByStreamId.set(response.streamId, {
        sessionId: parsed.data.diagnostics.sessionId,
        authorizationId: parsed.data.diagnostics.authorizationId,
        providerId: parsed.data.packId ?? 'daemon-default',
        requestId: parsed.data.requestId,
        pendingSegments: new Map<string, Buffer>(),
      });
    }
    return response;
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsStreamNextRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceTtsStreamNextResponseSchema);
    }
    const response = parseVoiceInferenceResponse(
      DaemonVoiceInferenceTtsStreamNextResponseSchema,
      await manager.next(parsed.data),
    );
    if (response.ok && response.event.type === 'segment') {
      const context = diagnosticContextByStreamId.get(response.streamId);
      if (context && !context.pendingSegments.has(response.event.segmentId)) {
        context.pendingSegments.set(
          response.event.segmentId,
          Buffer.from(response.event.audio.contentBase64, 'base64'),
        );
      }
    } else if (response.ok && (response.event.type === 'done' || response.event.type === 'error')) {
      diagnosticContextByStreamId.delete(response.streamId);
    }
    return response;
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsStreamAckRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceTtsStreamAckResponseSchema);
    }
    const response = parseVoiceInferenceResponse(
      DaemonVoiceInferenceTtsStreamAckResponseSchema,
      await manager.ack(parsed.data),
    );
    if (response.ok && response.complete) {
      const context = diagnosticContextByStreamId.get(response.streamId);
      diagnosticContextByStreamId.delete(response.streamId);
      if (context) {
        void Promise.all([...context.pendingSegments].map(([segmentId, bytes]) =>
          params.voiceDiagnostics?.capture({
            direction: 'tts_output',
            format: 'wav',
            bytes,
            durationMs: null,
            sessionId: context.sessionId,
            authorizationId: context.authorizationId,
            providerId: context.providerId,
            attemptId: `${context.requestId}:${segmentId}`,
          }),
        ));
      }
    }
    return response;
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsStreamCancelRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceTtsStreamCancelResponseSchema);
    }
    const response = parseVoiceInferenceResponse(
      DaemonVoiceInferenceTtsStreamCancelResponseSchema,
      await manager.cancel(parsed.data),
    );
    diagnosticContextByStreamId.delete(parsed.data.streamId);
    return response;
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_STATUS, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsStreamStatusRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceTtsStreamStatusResponseSchema);
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceTtsStreamStatusResponseSchema,
      await manager.status(parsed.data),
    );
  });

  return {
    dispose: async () => {
      diagnosticContextByStreamId.clear();
      await manager.dispose();
    },
  };
}
