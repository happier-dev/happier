import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { t } from '@/text';

/** The name of an attached source, joined to the Account's current catalog; a Bundled source reads as the generic label. */
export function machineSetupSourceName(
  source: Readonly<{ kind: 'bundledPreset' } | { kind: 'accountPreset'; presetId: string }>,
  presets: readonly Pick<ManagedMachinePresetV1, 'id' | 'name'>[],
): string {
  if (source.kind === 'bundledPreset') return t('machinePresets.setup.tab.bundledPreset');
  return presets.find((entry) => entry.id === source.presetId)?.name ?? t('machinePresets.setup.tab.presetUnreadable');
}
