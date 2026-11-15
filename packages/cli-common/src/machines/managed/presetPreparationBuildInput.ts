import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { ManagedMachinePresetPreparationBuildInputV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationBuildInputV1';

export type { ManagedMachinePresetPreparationBuildInputV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationBuildInputV1';

export type ManagedMachinePresetPreparationBuildCompositionV1 = Readonly<{
  input: ManagedMachinePresetPreparationBuildInputV1;
  deferredSetup?: MachineSetupV1;
}>;

/**
 * Setup remains one ordered unit until its recipe owner can classify and compile
 * it for an uncredentialed image target. This owner never renders setup scripts
 * or resolves Saved Secrets, recipe credentials, enrollment or Account material.
 */
export function composeManagedMachinePresetPreparationBuildInputV1(params:
  ManagedMachinePresetPreparationBuildInputV1 & Readonly<{ setup?: MachineSetupV1 }>,
): ManagedMachinePresetPreparationBuildCompositionV1 {
  return { input: { launch: { provider: params.launch.provider, schemaVersion: params.launch.schemaVersion,
    choices: params.launch.choices }, cli: params.cli },
    ...(params.setup === undefined || Object.keys(params.setup).length === 0 ? {} : { deferredSetup: params.setup }) };
}
