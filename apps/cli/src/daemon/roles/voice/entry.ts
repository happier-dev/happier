import {
  registerMachineVoiceInferenceRpcHandlers,
  type MachineVoiceInferenceRpcRegistration,
} from '@/api/machine/rpcHandlers.voiceInference';
import type { VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';

import type { MachineRoleRpcRegistrar, MachineRoleStopReason } from '../types';

export type VoiceRoleContext = Readonly<{
  machineId: string;
  accountId: string | null;
  /**
   * Machine core owns how the worker process starts, including the
   * `voice.daemonInference` feature decision (null when the feature is off).
   */
  startVoiceInferenceWorkerForMachine: (machineId: string, accountId: string | null) => Promise<VoiceInferenceWorkerHandle | null>;
}>;

export type VoiceRoleActivation = Readonly<{
  worker: VoiceInferenceWorkerHandle;
  registration: MachineVoiceInferenceRpcRegistration;
  /** The worker stops the same way whether the role was turned off or the connection ends. */
  stop: (reason?: MachineRoleStopReason) => Promise<void>;
}>;

/** `voice` role: the voice inference worker and its `daemon.voiceInference.*` / `daemon.voiceDiagnostics.*` RPC families. */
export async function activateVoiceRole(
  ctx: VoiceRoleContext,
  registerRpc: MachineRoleRpcRegistrar,
): Promise<VoiceRoleActivation | null> {
  const worker = await timeWebLatencyPhase('machine.bootstrap.voice',
    () => ctx.startVoiceInferenceWorkerForMachine(ctx.machineId, ctx.accountId));
  if (!worker) return null;
  let registration: MachineVoiceInferenceRpcRegistration;
  try {
    registration = registerRpc(rpcHandlerManager => registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager, voiceInferenceWorker: worker,
    }));
  } catch (error) {
    await worker.stop();
    throw error;
  }
  return {
    worker,
    registration,
    stop: async () => {
      try {
        await registration.dispose();
      } finally {
        await worker.stop();
      }
    },
  };
}
