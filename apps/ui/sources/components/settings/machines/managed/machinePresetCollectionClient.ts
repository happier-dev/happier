export {
    captureManagedMachinePresetSavedSecretReferencesInContext,
    createMachinePresetCollectionClient,
    hasOpenedManagedMachinePresetCreationV1,
    isOpenedManagedMachinePresetV1,
    openManagedMachineReadSnapshots,
    openManagedMachineReadSnapshotsAtCustody,
    prepareManagedMachinePresetResizeOverrideForSnapshot,
    prepareManagedMachinePresetSavedSecretPromotionRewritesInContext,
    prepareManagedMachineResizeInputForSnapshot,
    readManagedMachineReadForSnapshot,
} from '@/sync/ops/machines/machinePresetCollectionClient';
export type * from '@/sync/ops/machines/machinePresetCollectionClient';
