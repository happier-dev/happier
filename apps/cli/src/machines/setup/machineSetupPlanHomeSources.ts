import type { MachineSetupPlanInputV1, MachineSetupSourceApplyV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

/** The direct and bundled wire arms are the same schemas as local copies. */
export function hasOnlyLocalSetupSources(sources: MachineSetupSourceApplyV1): sources is Exclude<
  MachineSetupSourceApplyV1[number], { kind: 'accountPresetOpaque' }>[] {
  return sources.every(source => source.kind !== 'accountPresetOpaque');
}

/** Explicit preset proposals require the Home resolver. A saved-copy Plan reads local state. */
export function machineSetupPlanNeedsHomeSources(input: Pick<MachineSetupPlanInputV1, 'sources' | 'candidatePreset'>): boolean {
  return input.candidatePreset !== undefined || (input.sources !== undefined && !hasOnlyLocalSetupSources(input.sources));
}
