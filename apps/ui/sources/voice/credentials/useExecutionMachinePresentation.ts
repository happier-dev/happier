import { storage } from '@/sync/domains/state/storage';
import { shallow } from 'zustand/vanilla/shallow';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useShallow } from 'zustand/react/shallow';
import { resolveMachineForActiveServerFromState, resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { resolveVoiceExecutionMachineIdFromState, resolveVoiceExecutionMachineSelectionFromState, type VoiceExecutionMachineSelection } from '@/voice/settings/executionMachine';
import { getMachineDisplayName, selectMachineDisplayNamePeers } from '@/utils/sessions/machineDisplayNames';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

export type VoiceExecutionMachinePresentation = Readonly<{
  selectedMachineId: string | null;
  machineId: string | null;
  machineLabel: string | null;
  selectionKind: VoiceExecutionMachineSelection['kind'];
}>;

// A subscription port, not another store: unrelated root writes do not even
// ask for naming inputs. Machine ingestion owns these source-slice identities.
const machineNamingSource = {
  getState: () => storage.getState(),
  getInitialState: () => storage.getInitialState(),
  subscribe: (listener: Parameters<typeof storage.subscribe>[0]) => storage.subscribe(listener, {
    machines: true, machineListByServerId: true, machineListStatusByServerId: true,
  }),
};

function machineLabelFromState(state: ReturnType<typeof storage.getState>, selectedMachineId: string | null): string | null {
  if (!selectedMachineId) return null;
  const scope = { serverId: getAppliedActiveServerSnapshot().serverId };
  const machines = resolveVisibleMachinesForActiveServerFromState(state, scope).filter(isMachineVisibleForLaunchSelection);
  const machine = resolveMachineForActiveServerFromState(state, selectedMachineId, scope);
  return getMachineDisplayName(machine ?? { id: selectedMachineId, absence: 'unlisted' }, machines);
}

function machineLabelFactsFromState(state: ReturnType<typeof storage.getState>, selectedMachineId: string | null) {
  if (!selectedMachineId) return [];
  const scope = { serverId: getAppliedActiveServerSnapshot().serverId };
  const machine = resolveMachineForActiveServerFromState(state, selectedMachineId, scope);
  const machines = resolveVisibleMachinesForActiveServerFromState(state, scope).filter(isMachineVisibleForLaunchSelection);
  // Primitive naming inputs, not whole Machine/metadata identities or an already
  // computed label. Presence, daemon state and unrelated metadata do not name it.
  return [
    machine?.id ?? null, machine?.metadata === null,
    machine?.metadata?.displayName ?? null, machine?.metadata?.host ?? null,
    machine?.availability?.kind ?? null,
    ...selectMachineDisplayNamePeers(machine, machines).flatMap(peer => [peer.id, peer.metadata?.host ?? null]),
  ];
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
function useVoiceExecutionMachineState<Value>(select: (state: ReturnType<typeof storage.getState>) => Value): Value {
  const scope = useAccountSettingsScope();
  useMachinePresenceMembership(scope?.serverId ?? null);
  useVoiceTargetStore((state) => scope
    ? state.autoTargetMachineByScope[accountSettingsScopeKeySuffix(scope)]
    : undefined);
  // Cache selection by the stable storage snapshot: presence can expire
  // between React's reads without the storage object changing.
  // A fresh selector on render also observes local auto-target and scope wakes.
  return storage(useShallow(select));
}

/** Execution consumers subscribe to selection, without machine label presentation. */
export function useVoiceExecutionMachineId(): string | null {
  return useVoiceExecutionMachineState(resolveVoiceExecutionMachineIdFromState);
}

/** Readiness needs selection/reachability, not a display-name projection. */
export function useVoiceExecutionMachineSelection(): Omit<VoiceExecutionMachinePresentation, 'machineLabel'> {
  const selection = useVoiceExecutionMachineState(resolveVoiceExecutionMachineSelectionFromState);
  const selectionKind = selection.kind;
  const selectedMachineId = selection.kind === 'none' ? null : selection.machineId;
  const machineId = selection.kind === 'resolved' ? selectedMachineId : null;
  return { selectedMachineId, machineId, selectionKind };
}

export function useVoiceExecutionMachinePresentation(): VoiceExecutionMachinePresentation {
  const selection = useVoiceExecutionMachineSelection();
  const selectedMachineId = selection.selectedMachineId;
  useStoreWithEqualityFn(machineNamingSource, state => machineLabelFactsFromState(state, selectedMachineId), shallow);
  // Resolve the demanded label after its naming inputs wake the consumer; root
  // notifications must not run a full naming projection before comparing it.
  const machineLabel = machineLabelFromState(storage.getState(), selectedMachineId);
  return { ...selection, machineLabel };
}
