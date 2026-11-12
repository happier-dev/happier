import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { DeploymentTemplateRefV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { RegistryItemV1 } from '@happier-dev/protocol/registries';
import { containsMachineSetupItem } from '@/components/settings/machines/managed/machineSetupItems';

/** What a Store listing can hand to a preset: one App or Software item, never a Setup recipe. */
export type StorePresetDoorItem = Exclude<MachinePresetItemV1, { kind: 'setupRecipe' }>;

/** Only an admitted ready App supplies an exact pin; an unmapped listing cannot join a preset. */
export function readStoreAppTemplateRef(item: RegistryItemV1): DeploymentTemplateRefV1 | null {
    if (item.payload.kind !== 'app' || item.payload.state !== 'ready') return null;
    return { sourceId: item.summary.sourceId, itemId: item.summary.itemId,
        // Registry admission requires an App summary version identifying this payload ref.
        version: item.summary.version!, ref: item.payload.ref };
}

/** Both App doors keep the same inert new-Project intent and exact catalog selection. */
export function storeAppPresetItem(name: string, templateRef: DeploymentTemplateRefV1): Extract<MachinePresetItemV1, { kind: 'app' }> {
    return { kind: 'app', definition: { name, project: { kind: 'create' }, definition: { from: 'catalogApp', templateRef } } };
}

/** The presets the door offers, each saying whether it already sets this item up. */
export function projectAddToPresetChoices<Row extends Readonly<{ serverId: string; preset: ManagedMachinePresetV1 }>>(
    rows: readonly Row[], item: StorePresetDoorItem,
): readonly (Row & Readonly<{ contains: boolean }>)[] {
    return rows.map(row => ({ ...row, contains: containsMachineSetupItem(row.preset.setup, item) }));
}
