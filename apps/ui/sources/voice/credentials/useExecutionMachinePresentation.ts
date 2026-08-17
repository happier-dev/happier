import { storage } from '@/sync/domains/state/storage';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { resolveVoiceExecutionMachineSelectionFromState } from '@/voice/settings/executionMachine';

/**
 * The single UI projection of the selected voice execution machine.
 * Credential settings use this for both display and request invalidation.
 */
export function useVoiceExecutionMachinePresentation(): Readonly<{
  machineId: string | null;
  machineLabel: string | null;
  selectionKind: 'resolved' | 'selected_unreachable' | 'none';
}> {
  const selectionKind = storage((state) => resolveVoiceExecutionMachineSelectionFromState(state).kind);
  const selectedMachineId = storage((state) => {
    const selection = resolveVoiceExecutionMachineSelectionFromState(state);
    return selection.kind === 'none' ? null : selection.machineId;
  });
  const machineId = selectionKind === 'resolved' ? selectedMachineId : null;
  const machineLabel = storage((state) => {
    if (!selectedMachineId) return null;
    const machine = resolveMachineForActiveServerFromState(state, selectedMachineId);
    return machine?.metadata?.displayName || machine?.metadata?.host || selectedMachineId;
  });
  return { machineId, machineLabel, selectionKind };
}
