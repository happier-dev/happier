/** Canonical data contracts; definePlugin accepts deeply readonly author values. */
export { createDockerMembershipStep } from '@happier-dev/cli-common/machineSetup/dockerMembership';
export { createDockerEngineSetupSteps, dockerEnginePresenceCheck } from '@happier-dev/cli-common/machineSetup/dockerEngine';
export type {
  MachineRecipeV1,
  MachineRecipeStepV1,
  MachineRecipeSelectionV1,
  MachineSetupV1,
  MachineSetupScriptV1,
  MachinePresetItemV1,
  MachineSetupPresetContributionV1,
  StoredAppPresetInputV1,
} from '@happier-dev/protocol';
