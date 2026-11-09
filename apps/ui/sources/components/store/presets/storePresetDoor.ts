import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { readMachineSetupAppIdentityV1, readMachineSetupRecipeIdentityV1, type MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

/** What a Store listing can hand to a preset: one App or Software item, never a Setup recipe. */
export type StorePresetDoorItem = Exclude<MachinePresetItemV1, { kind: 'setupRecipe' }>;

/** One item's identity inside a preset: a recipe by plugin + recipe (any revision), an App by its catalog or authored key. */
function itemIdentity(item: MachinePresetItemV1): string | undefined {
    if (item.kind === 'app') return readMachineSetupAppIdentityV1(item);
    return readMachineSetupRecipeIdentityV1(item.selection.ref);
}

/** The presets the door offers, each saying whether it already sets this item up. */
export function projectAddToPresetChoices<Row extends Readonly<{ serverId: string; preset: ManagedMachinePresetV1 }>>(
    rows: readonly Row[], item: StorePresetDoorItem,
): readonly (Row & Readonly<{ contains: boolean }>)[] {
    const identity = itemIdentity(item);
    return rows.map(row => ({ ...row, contains: identity !== undefined
        && (row.preset.setup?.items ?? []).some(entry => itemIdentity(entry) === identity) }));
}
