import { MachineScheduledInputV1Schema, MachineScheduledResultV1Schema } from '@happier-dev/protocol/machines/scheduled/scheduledV1';
import { MACHINE_SCHEDULED_ACTION_IDS } from '@happier-dev/protocol/machines/scheduled/actionIdsV1';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { assertLocalServiceReadCustody } from '@/daemon/local/services/credentialAdmission';
import { createScheduledObservation } from '@/daemon/scheduled/observation';

export function registerDaemonScheduledRpcHandlers(rpc: RpcHandlerRegistrar, options: Readonly<{
  machineId: string; accountId?: string;
  observation?: ReturnType<typeof createScheduledObservation>;
}>) {
  const observation = options.observation ?? createScheduledObservation();
  for (const actionId of MACHINE_SCHEDULED_ACTION_IDS) rpc.registerHandler(actionId, async (raw, context) => {
    const input = MachineScheduledInputV1Schema.parse(raw);
    await assertLocalServiceReadCustody({ accountId: options.accountId, machineId: options.machineId, context }, 'machine_inventory');
    if (input.machineId !== options.machineId) throw new RpcError('Machine target mismatch', RPC_ERROR_CODES.FORBIDDEN);
    return MachineScheduledResultV1Schema.parse(await (actionId === 'machines.scheduled.list'
      ? observation.list(input) : observation.watch(input, context?.signal)));
  });
  return observation;
}
