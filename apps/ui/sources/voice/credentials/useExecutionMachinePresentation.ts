import { storage } from '@/sync/domains/state/storage';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';

/**
 * The single UI projection of the selected voice execution machine.
 * Credential settings use this for both display and request invalidation.
 */
export function useVoiceExecutionMachinePresentation(): Readonly<{
  machineId: string | null;
  machineLabel: string | null;
}> {
  const machineId = storage(resolveVoiceExecutionMachineIdFromState);
  const machineLabel = storage((state) => {
    if (!machineId) return null;
    const machine = resolveMachineForActiveServerFromState(state, machineId);
    return machine?.metadata?.displayName || machine?.metadata?.host || machineId;
  });
  return { machineId, machineLabel };
}
