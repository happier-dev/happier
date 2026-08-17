import { listPreferredMachineIds } from '@/components/settings/pickers/resolvePreferredMachineId';
import { resolveReplacementAwareMachineRpcTarget } from '@/sync/domains/machines/identity/resolveReplacementAwareMachineRpcTarget';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveMachineForActiveServerFromState, resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import {
  VoiceExecutionMachineSettingsSchema,
  voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';

export type VoiceExecutionMachineOverride = Readonly<{ machineId: string }>;
export type VoiceExecutionMachineSelection =
  | Readonly<{ kind: 'resolved'; machineId: string }>
  | Readonly<{ kind: 'selected_unreachable'; machineId: string }>
  | Readonly<{ kind: 'none' }>;

function resolveReplacementAwareSelection(state: any, requestedMachineId: unknown): VoiceExecutionMachineSelection {
  const originMachineId = normalizeNonEmptyString(requestedMachineId);
  if (!originMachineId) return { kind: 'none' };

  const machines = resolveVisibleMachinesForActiveServerFromState(state);
  const target = resolveReplacementAwareMachineRpcTarget({
    machineId: originMachineId,
    machines,
  });
  if (!target) return { kind: 'selected_unreachable', machineId: originMachineId };

  const machine = resolveMachineForActiveServerFromState(state, target.machineId);
  return machine && isMachineOnline(machine)
    ? { kind: 'resolved', machineId: target.machineId }
    : { kind: 'selected_unreachable', machineId: target.machineId };
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
  if (override) return resolveReplacementAwareSelection(state, override.machineId);

  const rawVoice = state?.settings?.voice;
  if (
    rawVoice
    && typeof rawVoice === 'object'
    && Object.prototype.hasOwnProperty.call(rawVoice, 'executionMachine')
    && !VoiceExecutionMachineSettingsSchema.safeParse(rawVoice.executionMachine).success
  ) {
    return { kind: 'none' };
  }
  const target = voiceSettingsParse(state?.settings?.voice).executionMachine;
  const mode = target?.mode === 'fixed' ? 'fixed' : 'auto';
  const persistedMachineId = mode === 'fixed'
    ? normalizeNonEmptyString(target?.machineId)
    : normalizeNonEmptyString(target?.autoMachineId);

  if (persistedMachineId) return resolveReplacementAwareSelection(state, persistedMachineId);
  if (mode === 'fixed') return { kind: 'none' };

  const visibleMachines = resolveVisibleMachinesForActiveServerFromState(state);
  const preferredMachineIds = listPreferredMachineIds({
    machines: visibleMachines,
    recentMachinePaths: Array.isArray(state?.settings?.recentMachinePaths)
      ? state.settings.recentMachinePaths
      : [],
    onlineOnly: true,
  });

  for (const candidateMachineId of preferredMachineIds) {
    const resolved = resolveReplacementAwareSelection(state, candidateMachineId);
    if (resolved.kind === 'resolved') return resolved;
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

export function listVoiceExecutionMachinesFromState(state: any): readonly Machine[] {
  return resolveVisibleMachinesForActiveServerFromState(state);
}
