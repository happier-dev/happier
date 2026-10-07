import { MemoryStatusV1Schema, type MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export async function fetchDaemonMemoryStatus(args: Readonly<{
  serverId: string | null | undefined;
  machineId: string | null | undefined;
  /**
   * Caller cancellation, handed to the incumbent machine-RPC cancellation path so a
   * superseded status probe stops waiting locally and relays the cancel.
   */
  signal?: AbortSignal;
}>): Promise<MemoryStatusV1 | null> {
  const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : '';
  const machineId = typeof args.machineId === 'string' ? args.machineId.trim() : '';
  if (!serverId || !machineId) return null;

  const raw = await machineRpcWithServerScope<unknown, unknown>({
    machineId,
    serverId,
    method: RPC_METHODS.DAEMON_MEMORY_STATUS,
    payload: {},
    ...(args.signal ? { signal: args.signal } : {}),
  });
  return MemoryStatusV1Schema.parse(raw);
}
