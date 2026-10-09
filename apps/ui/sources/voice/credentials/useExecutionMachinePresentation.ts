import { storage } from '@/sync/domains/state/storage';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { resolveVoiceExecutionMachineSelectionFromState } from '@/voice/settings/executionMachine';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

export type VoiceExecutionMachinePresentation = Readonly<{
  selectedMachineId: string | null;
  machineId: string | null;
  machineLabel: string | null;
  selectionKind: 'resolved' | 'selected_unreachable' | 'none';
}>;

function machineLabelFromState(state: ReturnType<typeof storage.getState>, selectedMachineId: string | null): string | null {
  if (!selectedMachineId) return null;
  return getMachineDisplayName(resolveMachineForActiveServerFromState(state, selectedMachineId,
    { serverId: getAppliedActiveServerSnapshot().serverId })) ?? selectedMachineId;
}

/** The same machine facts used by mounted controls and prepared settings mutations. */
export function resolveVoiceExecutionMachinePresentationFromState(state: ReturnType<typeof storage.getState>): VoiceExecutionMachinePresentation {
  const selection = resolveVoiceExecutionMachineSelectionFromState(state);
  const selectedMachineId = selection.kind === 'none' ? null : selection.machineId;
  return {
    selectedMachineId,
    machineId: selection.kind === 'resolved' ? selectedMachineId : null,
    machineLabel: machineLabelFromState(state, selectedMachineId),
    selectionKind: selection.kind,
  };
}

/**
 * The single UI projection of the selected voice execution machine.
 * Credential settings use this for both display and request invalidation.
 */
export function useVoiceExecutionMachinePresentation(): VoiceExecutionMachinePresentation {
  const scope = useAccountSettingsScope();
  useVoiceTargetStore((state) => scope
    ? state.autoTargetMachineByScope[accountSettingsScopeKeySuffix(scope)]
    : undefined);
  const selectionKind = storage((state) => resolveVoiceExecutionMachineSelectionFromState(state).kind);
  const selectedMachineId = storage((state) => {
    const selection = resolveVoiceExecutionMachineSelectionFromState(state);
    return selection.kind === 'none' ? null : selection.machineId;
  });
  const machineId = selectionKind === 'resolved' ? selectedMachineId : null;
  const machineLabel = storage((state) => machineLabelFromState(state, selectedMachineId));
  return { selectedMachineId, machineId, machineLabel, selectionKind };
}
