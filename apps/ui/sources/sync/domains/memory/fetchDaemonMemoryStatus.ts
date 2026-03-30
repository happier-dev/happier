import { MemoryStatusV1Schema, RPC_METHODS, type MemoryStatusV1 } from '@happier-dev/protocol';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export async function fetchDaemonMemoryStatus(args: Readonly<{
  serverId: string | null | undefined;
  machineId: string | null | undefined;
}>): Promise<MemoryStatusV1 | null> {
  const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : '';
  const machineId = typeof args.machineId === 'string' ? args.machineId.trim() : '';
  if (!serverId || !machineId) return null;

  const raw = await machineRpcWithServerScope<unknown, unknown>({
    machineId,
    serverId,
    method: RPC_METHODS.DAEMON_MEMORY_STATUS,
    payload: {},
  });
  return MemoryStatusV1Schema.parse(raw);
}
