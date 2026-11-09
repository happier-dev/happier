/** Canonical data contracts; definePlugin accepts deeply readonly author values. */
export { DOCKER_ENGINE_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
export { createCaddyContainerSetupDeclarations, nativeCaddyProfile } from '@happier-dev/cli-common/machineSetup/caddyDeclarations';
export { getMachineFirewallExposureInputSchemaV1 } from '@happier-dev/protocol/machines/setup/machineFirewallV1';
export { createDockerMembershipStep } from '@happier-dev/cli-common/machineSetup/dockerMembership';
export { machineConnectorCredentialDirectory } from '@happier-dev/cli-common/machineSetup/credentialFile';
export { createDockerEngineSetupSteps, dockerEnginePresenceCheck } from '@happier-dev/cli-common/machineSetup/dockerEngine';
export { createTailscaleJoinSteps, tailscaleMembershipPrograms } from '@happier-dev/cli-common/relayAccess/providers/tailscale/membership';
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
