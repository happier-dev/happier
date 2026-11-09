import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachineSetupSourceEntryV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

export type BundledMachineSetupPresetChoice = Extract<MachineSetupSourceEntryV1, { kind: 'bundledPreset' }>
    & Readonly<{ id: string; name: string; description: string }>;
export type MachineSetupPresetChoice = ManagedMachinePresetV1 | BundledMachineSetupPresetChoice;
export type MachineSetupPresetInput = Pick<ManagedMachinePresetV1, 'id' | 'revision' | 'setup'>
    | Extract<MachineSetupSourceEntryV1, { kind: 'bundledPreset' }>;

/** Saved and bundled setup presets share the same list and source preparation. */
export function readMachineSetupPresetChoices(
    saved: readonly ManagedMachinePresetV1[],
    projection: Pick<PluginUiProjectionModel, 'machineSetupPresetsById'> | null,
    localize: PluginLocalizedTextResolver,
): MachineSetupPresetChoice[] {
    return [
        ...saved.filter(preset => preset.setup && preset.archivedAt == null),
        ...Object.values(projection?.machineSetupPresetsById ?? {}).map((entry): BundledMachineSetupPresetChoice => ({
            kind: 'bundledPreset', id: entry.id, name: localize(entry.pluginId, entry.definition.title),
            description: entry.definition.description ? localize(entry.pluginId, entry.definition.description) : '',
            ref: { pluginId: entry.pluginId, localId: entry.definition.id, revision: entry.definition.revision },
            setup: entry.definition.setup,
        })),
    ];
}

export function machineSetupPresetSource(preset: MachineSetupPresetInput): Exclude<MachineSetupSourceEntryV1, { kind: 'direct' }> {
    return 'kind' in preset
        ? { kind: 'bundledPreset', ref: preset.ref, setup: preset.setup }
        : { kind: 'accountPreset', presetId: preset.id, presetRevision: preset.revision, setup: preset.setup ?? {} };
}
