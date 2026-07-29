import {
  DaemonVoiceInferenceSttStreamCancelRequestSchema,
  DaemonVoiceInferenceSttStreamCancelResponseSchema,
  type DaemonVoiceInferenceSttStreamCancelResponse,
  DaemonVoiceInferenceSttStreamChunkRequestSchema,
  DaemonVoiceInferenceSttStreamChunkResponseSchema,
  type DaemonVoiceInferenceSttStreamChunkResponse,
  type PeerApplicationEncryptionAuthorityBindingV1,
  type VoiceMediaApplicationAuthorityV1,
  DaemonVoiceInferenceSttStreamFinishRequestSchema,
  DaemonVoiceInferenceSttStreamFinishResponseSchema,
  DaemonVoiceInferenceSttStreamStartRequestSchema,
  DaemonVoiceInferenceSttStreamStartResponseSchema,
  DaemonVoiceInferenceSttStreamStatusRequestSchema,
  DaemonVoiceInferenceSttStreamStatusResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

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
  pcm16Bytes: Uint8Array;
  peerApplicationEncryption?: PeerApplicationEncryptionAuthorityBindingV1;
  substreamId?: string;
  carrierSequence?: number;
  voiceMediaApplicationAuthority: VoiceMediaApplicationAuthorityV1;
}>;

export type MachineVoiceInferenceSttBinaryAppendConsumer = (
  input: MachineVoiceInferenceSttBinaryAppendInput,
) => Promise<DaemonVoiceInferenceSttStreamChunkResponse | Uint8Array>;

export type MachineVoiceInferenceStreamingRpcRegistration = Readonly<{
  appendSttStreamBinaryFrame: MachineVoiceInferenceSttBinaryAppendConsumer;
  cancelSttStreamForTransportLoss: (input: Readonly<{
    peerApplicationEncryption?: PeerApplicationEncryptionAuthorityBindingV1;
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
  voiceDiagnostics?: Pick<VoiceDiagnosticsController, 'capture'>;
}>): MachineVoiceInferenceStreamingRpcRegistration {
  const streamManager = createVoiceInferenceSpeechStreamManager({
    voiceInferenceWorker: params.voiceInferenceWorker,
    voiceDiagnostics: params.voiceDiagnostics,
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttStreamStartRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceSttStreamStartResponseSchema);
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceSttStreamStartResponseSchema,
      await streamManager.start(parsed.data),
    );
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttStreamChunkRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceSttStreamChunkResponseSchema);
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceSttStreamChunkResponseSchema,
      await streamManager.appendCompatibilityChunk(parsed.data),
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

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttStreamStatusRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceSttStreamStatusResponseSchema);
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceSttStreamStatusResponseSchema,
      await streamManager.status(parsed.data),
    );
  });

  return {
    appendSttStreamBinaryFrame: async (input) => {
      if (input.peerApplicationEncryption) {
        if (!input.substreamId || input.carrierSequence === undefined) {
          throw new Error('daemon_voice_inference_encryption_binding_missing');
        }
        return await streamManager.appendPeerApplicationFrame({
          binding: input.peerApplicationEncryption,
          streamId: input.streamId,
          generation: input.generation,
          substreamId: input.substreamId,
          carrierSequence: input.carrierSequence,
          payloadBytes: input.pcm16Bytes,
        });
      }
      return parseVoiceInferenceResponse(
        DaemonVoiceInferenceSttStreamChunkResponseSchema,
        await streamManager.appendPcm16Bytes(input),
      );
    },
    cancelSttStreamForTransportLoss: async (input) => (
      await streamManager.cancelForTransportLoss(input)
    ),
    dispose: async () => {
      await streamManager.dispose();
    },
  };
}
