import type { MachineSetupSourceEntryV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { ManagedMachinePresetListEntryV1, OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';

import { t } from '@/text';

/** Attached source names use the same saved and bundled choices as the preset list. */
export function machineSetupSourceName(
  source: Readonly<Pick<Extract<MachineSetupSourceEntryV1, { kind: 'bundledPreset' }>, 'kind' | 'ref'>
    | { kind: 'accountPreset' | 'accountPresetOpaque'; presetId: string }>,
  presets: readonly (Pick<ManagedMachinePresetListEntryV1, 'id'> & Partial<Pick<OpenedManagedMachinePresetV1, 'name'>>
    & { ref?: Extract<MachineSetupSourceEntryV1, { kind: 'bundledPreset' }>['ref'] })[],
): string {
  if (source.kind === 'bundledPreset') return presets.find(preset => preset.ref?.pluginId === source.ref.pluginId
    && preset.ref.localId === source.ref.localId)?.name ?? t('machinePresets.setup.tab.bundledPreset');
  return presets.find((entry) => entry.id === source.presetId)?.name ?? t('machinePresets.setup.tab.presetUnreadable');
}
