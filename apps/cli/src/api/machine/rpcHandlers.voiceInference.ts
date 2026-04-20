import {
  DaemonVoiceInferenceModelsInstallRequestSchema,
  DaemonVoiceInferenceModelsInstallResponseSchema,
  DaemonVoiceInferenceModelsListResponseSchema,
  DaemonVoiceInferenceModelsRemoveRequestSchema,
  DaemonVoiceInferenceModelsRemoveResponseSchema,
  DaemonVoiceInferenceModelsStatusRequestSchema,
  DaemonVoiceInferenceModelsStatusResponseSchema,
  DaemonVoiceInferenceModelsWarmRequestSchema,
  DaemonVoiceInferenceModelsWarmResponseSchema,
  DaemonVoiceInferenceStatusResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

import { registerMachineVoiceInferenceTransferRpcHandlers } from './rpcHandlers.voiceInferenceTransfers';
import { parseVoiceInferenceResponse, toVoiceInferenceError } from './voiceInferenceRpcResponses';

export function registerMachineVoiceInferenceRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  voiceInferenceWorker: VoiceInferenceWorkerHandle;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS, async () => {
    try {
      const status = await params.voiceInferenceWorker.getStatus();
      return DaemonVoiceInferenceStatusResponseSchema.parse({ ok: true, ...status });
    } catch (error) {
      return toVoiceInferenceError(error);
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST, async () => {
    try {
      return DaemonVoiceInferenceModelsListResponseSchema.parse({
        ok: true,
        models: await params.voiceInferenceWorker.listModels(),
      });
    } catch (error) {
      return toVoiceInferenceError(error);
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceModelsStatusRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return toVoiceInferenceError(new Error('invalid_parameters'));
    }
    try {
      return parseVoiceInferenceResponse(DaemonVoiceInferenceModelsStatusResponseSchema, {
        ok: true,
        models: await params.voiceInferenceWorker.getModelsStatus(parsed.data.packIds ?? null),
      });
    } catch (error) {
      return toVoiceInferenceError(error);
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceModelsWarmRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return toVoiceInferenceError(new Error('invalid_parameters'));
    }
    try {
      const packIds = [...new Set(parsed.data.packIds)];
      for (const packId of packIds) {
        await params.voiceInferenceWorker.warmModelPack(packId);
      }
      return parseVoiceInferenceResponse(DaemonVoiceInferenceModelsWarmResponseSchema, {
        ok: true,
        models: await params.voiceInferenceWorker.getModelsStatus(packIds),
      });
    } catch (error) {
      return toVoiceInferenceError(error);
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceModelsInstallRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return toVoiceInferenceError(new Error('invalid_parameters'));
    }
    try {
      return parseVoiceInferenceResponse(DaemonVoiceInferenceModelsInstallResponseSchema, {
        ok: true,
        model: await params.voiceInferenceWorker.installModel(parsed.data),
      });
    } catch (error) {
      return toVoiceInferenceError(error);
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceModelsRemoveRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return toVoiceInferenceError(new Error('invalid_parameters'));
    }
    try {
      await params.voiceInferenceWorker.removeModel(parsed.data.packId);
      return parseVoiceInferenceResponse(DaemonVoiceInferenceModelsRemoveResponseSchema, { ok: true });
    } catch (error) {
      return toVoiceInferenceError(error);
    }
  });

  registerMachineVoiceInferenceTransferRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    voiceInferenceWorker: params.voiceInferenceWorker,
  });
}
