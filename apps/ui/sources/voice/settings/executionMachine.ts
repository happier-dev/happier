import { listPreferredMachineIds } from '@/components/settings/pickers/resolvePreferredMachineId';
import { resolveReplacementAwareMachineRpcTarget } from '@/sync/domains/machines/identity/resolveReplacementAwareMachineRpcTarget';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveMachineForActiveServerFromState, resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
  VoiceExecutionMachineSettingsSchema,
  voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';

export type VoiceExecutionMachineOverride = Readonly<{ machineId: string }>;

function resolveActiveReplacementAwareTarget(state: any, requestedMachineId: unknown): string | null {
  const originMachineId = normalizeNonEmptyString(requestedMachineId);
  if (!originMachineId) return null;

  const machines = resolveVisibleMachinesForActiveServerFromState(state);
  const target = resolveReplacementAwareMachineRpcTarget({
    machineId: originMachineId,
    machines,
  });
  if (!target) return null;

  const machine = resolveMachineForActiveServerFromState(state, target.machineId);
  return machine?.active === true ? target.machineId : null;
}

/**
 * Sole host-global voice daemon target resolver. It owns initial deterministic
 * auto selection, sticky/fixed behavior, replacement following, and fail-closed
 * reachability. It deliberately has no directory dependency.
 */
export function resolveVoiceExecutionMachineIdFromState(
  state: any,
  override?: VoiceExecutionMachineOverride | null,
): string | null {
  if (override) return resolveActiveReplacementAwareTarget(state, override.machineId);

  const rawVoice = state?.settings?.voice;
  if (
    rawVoice
    && typeof rawVoice === 'object'
    && Object.prototype.hasOwnProperty.call(rawVoice, 'executionMachine')
    && !VoiceExecutionMachineSettingsSchema.safeParse(rawVoice.executionMachine).success
  ) {
    return null;
  }
  const target = voiceSettingsParse(state?.settings?.voice).executionMachine;
  const mode = target?.mode === 'fixed' ? 'fixed' : 'auto';
  const persistedMachineId = mode === 'fixed'
    ? normalizeNonEmptyString(target?.machineId)
    : normalizeNonEmptyString(target?.autoMachineId);

  if (persistedMachineId) return resolveActiveReplacementAwareTarget(state, persistedMachineId);
  if (mode === 'fixed') return null;

  const visibleMachines = resolveVisibleMachinesForActiveServerFromState(state);
  const preferredMachineIds = listPreferredMachineIds({
    machines: visibleMachines,
    recentMachinePaths: Array.isArray(state?.settings?.recentMachinePaths)
      ? state.settings.recentMachinePaths
      : [],
    onlineOnly: true,
  });

  for (const candidateMachineId of preferredMachineIds) {
    const resolved = resolveActiveReplacementAwareTarget(state, candidateMachineId);
    if (resolved) return resolved;
  }
  return null;
}

export function resolveVoiceExecutionMachineId(
  override?: VoiceExecutionMachineOverride | null,
): string | null {
  return resolveVoiceExecutionMachineIdFromState(storage.getState(), override);
}

export function listVoiceExecutionMachinesFromState(state: any): readonly Machine[] {
  return resolveVisibleMachinesForActiveServerFromState(state);
}
