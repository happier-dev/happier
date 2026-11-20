import { DaemonVoiceInferenceSttStreamCancelRequestSchema, DaemonVoiceInferenceSttStreamCancelResponseSchema, DaemonVoiceInferenceSttStreamChunkRequestSchema, DaemonVoiceInferenceSttStreamChunkResponseSchema, DaemonVoiceInferenceSttStreamFinishRequestSchema, DaemonVoiceInferenceSttStreamFinishResponseSchema, DaemonVoiceInferenceSttStreamStartRequestSchema, DaemonVoiceInferenceSttStreamStartResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import type { DaemonVoiceInferenceSttStreamCancelResponse, DaemonVoiceInferenceSttStreamChunkResponse, VoiceMediaApplicationAuthorityV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import {
  createVoiceInferenceSpeechStreamManager,
  type VoiceInferenceSpeechStreamWorker,
} from '@/daemon/voiceInference/streaming/voiceInferenceSpeechStreamManager';

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

export type MachineVoiceInferenceSttBinaryAppendInput = Readonly<{
  streamId: string;
  generation: number;
  seq: number;
  payloadBytes: Uint8Array;
  voiceMediaApplicationAuthority: VoiceMediaApplicationAuthorityV1;
}>;

export type MachineVoiceInferenceSttBinaryAppendConsumer = (
  input: MachineVoiceInferenceSttBinaryAppendInput,
) => Promise<DaemonVoiceInferenceSttStreamChunkResponse | Uint8Array>;

export type MachineVoiceInferenceStreamingRpcRegistration = Readonly<{
  appendSttStreamBinaryFrame: MachineVoiceInferenceSttBinaryAppendConsumer;
  cancelSttStreamForTransportLoss: (input: Readonly<{
    voiceMediaApplicationAuthority: VoiceMediaApplicationAuthorityV1;
  }> & (
    | Readonly<{ streamId: string; generation: number }>
    | Readonly<{ streamId?: never; generation?: never }>
  )) => Promise<DaemonVoiceInferenceSttStreamCancelResponse>;
  dispose: () => Promise<void>;
}>;

export function registerMachineVoiceInferenceStreamingRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  voiceInferenceWorker: VoiceInferenceSpeechStreamWorker;
  voiceDiagnostics?: Pick<VoiceDiagnosticsController, 'captureFile'>;
}>): MachineVoiceInferenceStreamingRpcRegistration {
  const streamManager = createVoiceInferenceSpeechStreamManager({
    voiceInferenceWorker: params.voiceInferenceWorker,
    voiceDiagnostics: params.voiceDiagnostics,
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START, async (raw: unknown, context) => {
    const parsed = DaemonVoiceInferenceSttStreamStartRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceSttStreamStartResponseSchema);
    }
    // The stream key exists exactly when this call's admitted content is E2EE:
    // it then leaves inside that sealed response. Plain Accounts stream plain
    // frames. Unknown content is refused, never reinterpreted as plain.
    const contentMode = context?.contentMode;
    if (!contentMode) {
      return parseVoiceInferenceResponse(DaemonVoiceInferenceSttStreamStartResponseSchema, toVoiceInferenceError(
        Object.assign(new Error('daemon_voice_inference_stream_content_mode_unavailable'), { code: 'runtime_unavailable' })));
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceSttStreamStartResponseSchema,
      await streamManager.start(parsed.data, context.signal, { issueStreamKey: contentMode === 'e2ee' }),
    );
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK, async (raw, context) => {
    const parsed = DaemonVoiceInferenceSttStreamChunkRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceSttStreamChunkResponseSchema);
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceSttStreamChunkResponseSchema,
      await streamManager.appendCompatibilityChunk(parsed.data, context?.contentMode === 'e2ee'),
    );
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttStreamFinishRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceSttStreamFinishResponseSchema);
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceSttStreamFinishResponseSchema,
      await streamManager.finish(parsed.data),
    );
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttStreamCancelRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceSttStreamCancelResponseSchema);
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceSttStreamCancelResponseSchema,
      await streamManager.cancel(parsed.data),
    );
  });

  return {
    appendSttStreamBinaryFrame: async (input) => {
      const response = await streamManager.appendTunnelFrame(input);
      return response instanceof Uint8Array
        ? response
        : parseVoiceInferenceResponse(DaemonVoiceInferenceSttStreamChunkResponseSchema, response);
    },
    cancelSttStreamForTransportLoss: async (input) => (
      await streamManager.cancelForTransportLoss(input)
    ),
    dispose: async () => {
      await streamManager.dispose();
    },
  };
}
