import type { MachineSetupPlanInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

/** Explicit preset proposals require the Home resolver. A saved-copy Plan reads local state. */
export function machineSetupPlanNeedsHomeSources(input: Pick<MachineSetupPlanInputV1, 'sources' | 'candidatePreset'>): boolean {
  return input.candidatePreset !== undefined || input.sources?.some(source => source.kind === 'accountPresetOpaque') === true;
}
