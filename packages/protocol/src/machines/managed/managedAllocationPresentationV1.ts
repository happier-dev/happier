import type { ActionOperationSnapshotV1 } from '../../actions/operations/v1.js';
import type { ManagedMachineV1 } from './managedMachineV1.js';

export type ManagedMachineAllocationPresentationV1 = ManagedMachineV1['allocation'] | 'creating';

/**
 * Allocation is not operation progress. Only the current creation operation, already correlated by its
 * owner to this resource/controller, can establish active creation; an absent receipt stays uncertain.
 * This helper performs no operation lookup, correlation, admission or translated screen presentation.
 */
export function classifyManagedMachineAllocationV1(
  machine: Pick<ManagedMachineV1, 'allocation'>,
  currentCreationOperation?: Pick<ActionOperationSnapshotV1, 'actionId' | 'state'> | null,
): ManagedMachineAllocationPresentationV1 {
  if (machine.allocation !== 'may-exist') return machine.allocation;
  return currentCreationOperation?.state === 'running'
    && (currentCreationOperation.actionId === 'machines.managed.acquire'
      || currentCreationOperation.actionId === 'machines.managed.bootstrap.retry')
    ? 'creating' : 'may-exist';
}
