/** Store uses the Setup tab's native read/review/apply/remove lifecycle, including its operation and approvals. */
export { useMachineSetup as useStorePresetSetup } from '@/components/machines/setup/useMachineSetup';
export type { MachineSetupState as StorePresetSetupState, MachineSetupReviewIntent } from '@/components/machines/setup/useMachineSetup';
export { prepareMachineSetupSourcesApplyInput } from '@/components/settings/machines/managed/machineSetupReview';
export type { MachineSetupReviewTarget, MachineSetupPreparedApply } from '@/components/settings/machines/managed/machineSetupReview';
export { machinePresetEditContinuationDraft } from '@/components/settings/machines/managed/machinePresetEditDraft';
export type { MachinePresetEditContinuation, MachinePresetEditDraft } from '@/components/settings/machines/managed/machinePresetEditDraft';
