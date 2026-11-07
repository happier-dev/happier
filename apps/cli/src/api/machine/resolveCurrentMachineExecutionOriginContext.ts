import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { MachineTargetV1 } from '@happier-dev/protocol/machines/machineAccessV1';

/** The target's serverId is the portable Home identity, never a local profile alias. */
export function createBoundMachineTargetResolver(params: Readonly<{
  resolveCurrentServerIdentityId(): string | null;
  resolveCurrentMachineId(): string | null;
}>): () => MachineTargetV1 | null {
  return () => {
    const serverId = params.resolveCurrentServerIdentityId();
    let machineId: string | null;
    try {
      machineId = params.resolveCurrentMachineId();
    } catch {
      return null;
    }
    return serverId && machineId ? Object.freeze({ serverId, machineId }) : null;
  };
}

/**
 * Pair the bound Home identity with the current local Machine. A daemon
 * consumes its authenticated connection binding; callers without one must
 * discover it freshly. This stamp does not replace effect admission.
 */
export type CurrentMachineExecutionOriginContext = Readonly<{
  serverIdentityId: string;
  machineId: string;
}>;

export function createCurrentMachineExecutionOriginContextResolver(params: Readonly<{
  serverUrl: string;
  resolveCurrentMachineId(): string | null;
  resolveCurrentServerIdentityId?(): string | null;
  timeoutMs?: number;
}>): (signal?: AbortSignal) => Promise<CurrentMachineExecutionOriginContext | null> {
  return async (signal?: AbortSignal): Promise<CurrentMachineExecutionOriginContext | null> => {
    signal?.throwIfAborted();
    let serverIdentityId: string | null | undefined;
    if (params.resolveCurrentServerIdentityId) {
      serverIdentityId = params.resolveCurrentServerIdentityId();
    } else {
      const snapshot = await observeServerFeaturesSnapshot({
        serverUrl: params.serverUrl,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      });
      serverIdentityId = snapshot.status === 'ready'
        ? snapshot.features.capabilities.serverIdentity.serverIdentityId
        : null;
    }
    signal?.throwIfAborted();
    const target = createBoundMachineTargetResolver({
      resolveCurrentServerIdentityId: () => serverIdentityId ?? null,
      resolveCurrentMachineId: params.resolveCurrentMachineId,
    })();
    return target
      ? Object.freeze({ serverIdentityId: target.serverId, machineId: target.machineId })
      : null;
  };
}
