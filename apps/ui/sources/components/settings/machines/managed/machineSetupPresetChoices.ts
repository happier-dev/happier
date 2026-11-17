import type { MachineSetupSourceApplyEntryV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachinePresetLaunchNameOverrideV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { MachineSetupSourceEntryV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { isOpenedManagedMachinePresetV1, type ManagedMachinePresetListEntryV1, type OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';

export type BundledMachineSetupPresetChoice = Extract<MachineSetupSourceEntryV1, { kind: 'bundledPreset' }>
    & Readonly<{ id: string; name: string; description: string }>;
export type SavedMachineSetupPresetChoice = OpenedManagedMachinePresetV1
    & Readonly<{ setup: NonNullable<OpenedManagedMachinePresetV1['setup']> }>;
export type MachineSetupPresetChoice = SavedMachineSetupPresetChoice | BundledMachineSetupPresetChoice;
export type MachineSetupPresetInput = Pick<OpenedManagedMachinePresetV1,
    'id' | 'revision' | 'contentEncryptionMode' | 'setup' | 'setupRevision'> & Partial<Pick<OpenedManagedMachinePresetV1, 'recipientProjection'>>
    | Extract<MachineSetupSourceEntryV1, { kind: 'bundledPreset' }>;

/** Saved and bundled setup presets share the same list and source preparation. */
export function readMachineSetupPresetChoices(
    saved: readonly ManagedMachinePresetListEntryV1[],
    projection: Pick<PluginUiProjectionModel, 'machineSetupPresetsById'> | null,
    localize: PluginLocalizedTextResolver,
): MachineSetupPresetChoice[] {
    return [
        ...saved.filter(isOpenedManagedMachinePresetV1).filter((preset): preset is SavedMachineSetupPresetChoice => !!preset.setup && preset.archivedAt == null),
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
        : { kind: 'accountPreset', presetId: preset.id, presetRevision: preset.revision,
            ...(preset.setupRevision === undefined ? {} : { setupRevision: preset.setupRevision }),
            contentEncryptionMode: preset.contentEncryptionMode, setup: preset.setup ?? {} };
}

/** The Action/Home wire carries saved setup presets by exact opaque revision, never their opened setup bytes. */
export function machineSetupPresetApplySource(preset: MachineSetupPresetInput,
    presetContentOverride?: ManagedMachinePresetLaunchNameOverrideV1): MachineSetupSourceApplyEntryV1 {
    if ('kind' in preset) return { kind: 'bundledPreset', ref: preset.ref, setup: preset.setup };
    return { kind: 'accountPresetOpaque', presetId: preset.id, presetRevision: preset.revision,
        ...(preset.setupRevision === undefined ? {} : { setupRevision: preset.setupRevision }),
        contentEncryptionMode: preset.contentEncryptionMode,
        ...(presetContentOverride ? { presetContentOverride } : {}) };
}
