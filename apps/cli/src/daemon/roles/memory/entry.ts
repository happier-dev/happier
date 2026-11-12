import { registerMachineMemoryRpcHandlers } from '@/api/machine/rpcHandlers.memory';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import { subscribeMemorySessionRemoval } from '@/daemon/memory/subscribeMemorySessionRemoval';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';

import type { MachineRoleRpcRegistrar, MachineRoleStopReason } from '../types';

type MemorySessionRemovalEvents = Omit<Parameters<typeof subscribeMemorySessionRemoval>[0], 'memoryWorker'>;

export type MemoryRoleContext = Readonly<{
  machineId: string;
  /** Machine core owns how the worker process starts; the role decides whether it runs. */
  startMemoryWorkerForMachine: (machineId: string) => Promise<MemoryWorkerHandle | null>;
  memorySessionEvents: MemorySessionRemovalEvents;
}>;

export type MemoryRoleActivation = Readonly<{
  worker: MemoryWorkerHandle;
  /** The worker stops the same way whether the role was turned off or the connection ends. */
  stop: (reason?: MachineRoleStopReason) => Promise<void>;
}>;

/** `memory` role: the memory indexer front + worker and its `daemon.memory.*` RPC family. */
export async function activateMemoryRole(
  ctx: MemoryRoleContext,
  registerRpc: MachineRoleRpcRegistrar,
): Promise<MemoryRoleActivation | null> {
  const worker = await timeWebLatencyPhase('machine.bootstrap.memory', () => ctx.startMemoryWorkerForMachine(ctx.machineId));
  if (!worker) return null;
  // Derived daemon-memory rows for a deleted, access-revoked, or archive-excluded
  // Session are cleared through the memory owner's single removal operation.
  // Deletion/revocation purges run inside the Account change cursor's custody
  // window, so a failure replays the fact. Subscribed before the changes carrier
  // connects (machine bootstrap activates roles first).
  const disposeSessionRemoval = subscribeMemorySessionRemoval({ memoryWorker: worker, ...ctx.memorySessionEvents });
  try {
    registerRpc(rpcHandlerManager => registerMachineMemoryRpcHandlers({ rpcHandlerManager, memoryWorker: worker }));
  } catch (error) {
    disposeSessionRemoval();
    await worker.stop();
    throw error;
  }
  return {
    worker,
    stop: async () => {
      disposeSessionRemoval();
      await worker.stop();
    },
  };
}
