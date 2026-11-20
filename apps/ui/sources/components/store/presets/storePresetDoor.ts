import type { OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import type { MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { DeploymentTemplateRefV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { RegistryItemV1 } from '@happier-dev/protocol/registries';
import { containsMachineSetupItem } from '@/components/settings/machines/managed/machineSetupItems';

/** One item carried from a Store listing into the preset editor’s Setup. */
export type StorePresetDoorItem = MachinePresetItemV1;

/** Only an admitted ready App supplies a template and its exact pin. */
export function readStoreAppTemplate(item: RegistryItemV1) {
    if (item.payload.kind !== 'app' || item.payload.state !== 'ready') return null;
    const templateRef: DeploymentTemplateRefV1 = { sourceId: item.summary.sourceId, itemId: item.summary.itemId,
        // Registry admission requires an App summary version identifying this payload ref.
        version: item.summary.version!, ref: item.payload.ref };
    return { templateRef, app: item.payload.app };
}

export function readStoreAppTemplateRef(item: RegistryItemV1): DeploymentTemplateRefV1 | null {
    return readStoreAppTemplate(item)?.templateRef ?? null;
}

/** Both App doors keep the same inert new-Project intent and exact catalog selection. */
export function storeAppPresetItem(name: string, templateRef: DeploymentTemplateRefV1): Extract<MachinePresetItemV1, { kind: 'app' }> {
    return { kind: 'app', definition: { name, project: { kind: 'create' }, bindings: [], definition: { from: 'catalogApp', templateRef } } };
}

/** The presets the door offers, each saying whether it already sets this item up. */
export function projectAddToPresetChoices<Row extends Readonly<{ serverId: string; preset: OpenedManagedMachinePresetV1 }>>(
    rows: readonly Row[], item: StorePresetDoorItem,
): readonly (Row & Readonly<{ contains: boolean }>)[] {
    return rows.map(row => ({ ...row, contains: containsMachineSetupItem(row.preset.setup, item) }));
}
