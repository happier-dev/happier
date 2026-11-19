import { machineSetupItemKeyV1, machineSetupSourceOriginKeyV1, type MachineSetupSourceV1, type MachineSetupSourceFactsMapV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { readMachineSetupInitialPresenceV1 } from '@happier-dev/cli-common/machineSetup';
import { isMachineSetupRecipeItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

export function observeMachineSetupInitialPresence(sources: MachineSetupSourceV1,
  recipePlans: readonly { sourceIndex: number; itemIndex: number; plan: MachineSetupEffectPlanV1;
    initialPresence?: 'present' | 'absent' | 'unknown' }[]): MachineSetupSourceFactsMapV1 {
  const observed = new Map<string, 'present' | 'absent' | undefined>();
  for (const entry of recipePlans) {
    const item = sources[entry.sourceIndex]?.setup.items?.[entry.itemIndex];
    if (!item || !isMachineSetupRecipeItemV1(item)) continue;
    const key = machineSetupItemKeyV1(item);
    const next = entry.initialPresence === 'unknown' ? undefined
      : entry.initialPresence ?? readMachineSetupInitialPresenceV1(entry.plan);
    observed.set(key, observed.get(key) === 'present' || next === 'present' ? 'present'
      : observed.has(key) && observed.get(key) !== next ? undefined : next);
  }
  const sourceFacts: MachineSetupSourceFactsMapV1 = {};
  for (const source of sources) {
    const firstPresence: Record<string, 'present' | 'absent'> = {};
    for (const item of source.setup.items ?? []) {
      if (!isMachineSetupRecipeItemV1(item)) continue;
      const key = machineSetupItemKeyV1(item);
      const first = observed.get(key);
      if (first !== undefined) firstPresence[key] = first;
    }
    if (Object.keys(firstPresence).length) sourceFacts[machineSetupSourceOriginKeyV1(source)] = { firstPresence };
  }
  return sourceFacts;
}
