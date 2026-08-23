import {
  DaemonVoiceInferenceModelsInstallRequestSchema,
  DaemonVoiceInferenceModelsInstallResponseSchema,
  DaemonVoiceInferenceModelLicenseAcceptRequestSchema,
  DaemonVoiceInferenceModelLicenseAcceptResponseSchema,
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

import {
  registerMachineVoiceInferenceTransferRpcHandlers,
  type MachineVoiceInferenceTransferRpcRegistration,
} from './rpcHandlers.voiceInferenceTransfers';
import {
  registerMachineVoiceInferenceStreamingRpcHandlers,
  type MachineVoiceInferenceStreamingRpcRegistration,
} from './rpcHandlers.voiceInferenceStreaming';
import {
  registerMachineVoiceInferenceTtsStreamingRpcHandlers,
  type MachineVoiceInferenceTtsStreamingRpcRegistration,
} from './rpcHandlers.voiceInferenceTtsStreaming';
import { parseVoiceInferenceResponse, toVoiceInferenceError } from './voiceInferenceRpcResponses';
import { configuration } from '@/configuration';
import {
  createVoiceDiagnosticsController,
  type VoiceDiagnosticsController,
} from '@/daemon/voiceDiagnostics/controller';
import { registerMachineVoiceDiagnosticsRpcHandlers } from './rpcHandlers.voiceDiagnostics';

export type MachineVoiceInferenceRpcRegistration = Readonly<{
  voiceInferenceTransfers: MachineVoiceInferenceTransferRpcRegistration;
  voiceInferenceStreaming: MachineVoiceInferenceStreamingRpcRegistration;
  voiceInferenceTtsStreaming: MachineVoiceInferenceTtsStreamingRpcRegistration;
  voiceDiagnostics: ReturnType<typeof createVoiceDiagnosticsController>;
  dispose: () => Promise<void>;
}>;

export function registerMachineVoiceInferenceRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  voiceInferenceWorker: VoiceInferenceWorkerHandle;
  voiceDiagnostics?: VoiceDiagnosticsController;
}>): MachineVoiceInferenceRpcRegistration {
  const voiceDiagnostics = params.voiceDiagnostics
    ?? createVoiceDiagnosticsController({ happyHomeDir: configuration.happyHomeDir });
  const voiceDiagnosticsRegistration = registerMachineVoiceDiagnosticsRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    diagnostics: voiceDiagnostics,
  });
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

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL, async (raw: unknown, context) => {
    const parsed = DaemonVoiceInferenceModelsInstallRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return toVoiceInferenceError(new Error('invalid_parameters'));
    }
    try {
      return parseVoiceInferenceResponse(DaemonVoiceInferenceModelsInstallResponseSchema, {
        ok: true,
        // The request's own lifetime bounds the install: a caller that timed out
        // or navigated away must not leave a download running to completion.
        model: await params.voiceInferenceWorker.installModel({
          ...parsed.data,
          signal: context?.signal ?? null,
        }),
      });
    } catch (error) {
      return toVoiceInferenceError(error);
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LICENSE_ACCEPT, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceModelLicenseAcceptRequestSchema.safeParse(raw);
    if (!parsed.success) return toVoiceInferenceError(new Error('invalid_parameters'));
    try {
      return parseVoiceInferenceResponse(DaemonVoiceInferenceModelLicenseAcceptResponseSchema, {
        ok: true,
        model: await params.voiceInferenceWorker.acceptModelPackLicense(parsed.data),
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

  const voiceInferenceTransfers = registerMachineVoiceInferenceTransferRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    voiceInferenceWorker: params.voiceInferenceWorker,
    voiceDiagnostics,
  });
  const voiceInferenceStreaming = registerMachineVoiceInferenceStreamingRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    voiceInferenceWorker: params.voiceInferenceWorker,
    voiceDiagnostics,
  });
  const voiceInferenceTtsStreaming = registerMachineVoiceInferenceTtsStreamingRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    voiceInferenceWorker: params.voiceInferenceWorker,
    voiceDiagnostics,
  });

  return {
    voiceInferenceTransfers,
    voiceInferenceStreaming,
    voiceInferenceTtsStreaming,
    voiceDiagnostics,
    dispose: async () => {
      await Promise.all([
        voiceInferenceTransfers.dispose(),
        voiceInferenceStreaming.dispose(),
        voiceInferenceTtsStreaming.dispose(),
        voiceDiagnosticsRegistration.dispose(),
      ]);
    },
  };
}
