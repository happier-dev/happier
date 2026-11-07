import { isMachineReplaced } from '@/sync/domains/machines/identity/machineIdentityTypes';
import { resolveReplacementAwareMachineRpcTarget } from '@/sync/domains/machines/identity/resolveReplacementAwareMachineRpcTarget';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveMachineForActiveServerFromState, resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { isMachineReachable, resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { readVoiceAutoTargetMachineId } from '@/voice/persistence/voiceAutoTargetMachineSettings';
import { readVoiceExecutionMachineSettings } from '@/sync/domains/settings/voiceSettings';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

export type VoiceExecutionMachineOverride = Readonly<{ machineId: string }>;
export type VoiceExecutionMachineSelection =
  | Readonly<{ kind: 'resolved'; machineId: string }>
  | Readonly<{ kind: 'selected_unreachable'; machineId: string }>
  | Readonly<{ kind: 'selected_unknown'; machineId: string }>
  | Readonly<{ kind: 'none' }>;

function resolveReplacementAwareSelection(state: any, requestedMachineId: unknown, serverId: string): VoiceExecutionMachineSelection {
  const originMachineId = normalizeNonEmptyString(requestedMachineId);
  if (!originMachineId) return { kind: 'none' };

  const machines = resolveVisibleMachinesForActiveServerFromState(state, { serverId });
  const target = resolveReplacementAwareMachineRpcTarget({
    machineId: originMachineId,
    machines,
  });
  if (!target) return { kind: 'selected_unreachable', machineId: originMachineId };

  const machine = resolveMachineForActiveServerFromState(state, target.machineId, { serverId });
  const scope = selectActiveServerAccountScopeForServer(state.profileScope, serverId);
  const reachability = machine ? resolveMachineReachability(scope, machine) : 'unreachable';
  return { kind: reachability === 'reachable' ? 'resolved'
    : reachability === 'unknown' ? 'selected_unknown' : 'selected_unreachable', machineId: target.machineId };
}

/** Readiness and settings retain an unobserved selected target without declaring it offline or missing. */
export function projectVoiceExecutionMachineReadiness(
  kind: VoiceExecutionMachineSelection['kind'] | undefined,
  machineId: string | null | undefined,
): 'ready' | 'missing' | 'unknown' | 'incompatible' {
  if (kind === 'selected_unknown') return 'unknown';
  if (kind === 'selected_unreachable') return 'incompatible';
  return machineId ? 'ready' : 'missing';
}

/**
 * Sole host-global voice daemon target resolver. It owns initial deterministic
 * auto selection, sticky/fixed behavior, replacement following, and fail-closed
 * reachability. It deliberately has no directory dependency.
 */
export function resolveVoiceExecutionMachineSelectionFromState(
  state: any,
  override?: VoiceExecutionMachineOverride | null,
): VoiceExecutionMachineSelection {
  // Runtime dispatch belongs to the applied Home, not a focused selection
  // staged while its connection is still being established.
  const serverId = getAppliedActiveServerSnapshot().serverId;
  if (override) return resolveReplacementAwareSelection(state, override.machineId, serverId);

  const target = readVoiceExecutionMachineSettings(state?.settings?.voice);
  if (!target) return { kind: 'none' };
  const mode = target?.mode === 'fixed' ? 'fixed' : 'auto';
  const persistedMachineId = mode === 'fixed'
    ? normalizeNonEmptyString(target?.machineId)
    : readVoiceAutoTargetMachineId(state);

  if (persistedMachineId) return resolveReplacementAwareSelection(state, persistedMachineId, serverId);
  if (mode === 'fixed') return { kind: 'none' };

  const visibleMachines = resolveVisibleMachinesForActiveServerFromState(state, { serverId });
  const scope = selectActiveServerAccountScopeForServer(state.profileScope, serverId);
  // Presence and authoring recency may change across surfaces without changing the
  // initial Voice target. Fixed and remembered targets were resolved above.
  const candidates = visibleMachines.filter(machine => !isMachineReplaced(machine))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));

  for (const machine of candidates) {
    if (isMachineReachable(scope, machine)) return { kind: 'resolved', machineId: machine.id };
  }
  return { kind: 'none' };
}

export function resolveVoiceExecutionMachineIdFromState(
  state: any,
  override?: VoiceExecutionMachineOverride | null,
): string | null {
  const selection = resolveVoiceExecutionMachineSelectionFromState(state, override);
  return selection.kind === 'resolved' ? selection.machineId : null;
}

export function resolveVoiceExecutionMachineId(
  override?: VoiceExecutionMachineOverride | null,
): string | null {
  return resolveVoiceExecutionMachineIdFromState(storage.getState(), override);
}

export function isCapturedVoiceExecutionMachineCurrent(
  capturedMachineId: string | null,
): boolean {
  const selection = resolveVoiceExecutionMachineSelectionFromState(storage.getState());
  return capturedMachineId === null
    ? selection.kind !== 'resolved'
    : selection.kind !== 'none' && selection.machineId === capturedMachineId;
}

export function listVoiceExecutionMachinesFromState(state: any): readonly Machine[] {
  return resolveVisibleMachinesForActiveServerFromState(state);
}
