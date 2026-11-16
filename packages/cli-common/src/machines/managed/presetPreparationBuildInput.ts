import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { ManagedMachinePresetPreparationBuildInputV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationBuildInputV1';
import type { MachineSetupPreparationV1 } from '@happier-dev/protocol/machines/setup/machineSetupPreparationV1';
import { buildMachineSetupPreparationCommandV1 } from '../../machineSetup/preparationCommand.js';

export type { ManagedMachinePresetPreparationBuildInputV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationBuildInputV1';

/** Produced only by the canonical recipe/setup owner; the exact baked subset
 * becomes artifact metadata after the native builder confirms success. */
export type ManagedMachinePresetPreparationSetupV1 = Readonly<{
  preparation?: MachineSetupPreparationV1;
  bakedSetup?: MachineSetupV1;
  deferredSetup?: MachineSetupV1;
}>;

export type ManagedMachinePresetPreparationBuildCompositionV1 = Readonly<Omit<ManagedMachinePresetPreparationSetupV1, 'preparation'> & {
  input: ManagedMachinePresetPreparationBuildInputV1;
}>;

/** Project the admitted image input without Account or enrollment material.
 * Compilation runs in the actual image through the supplied CLI, while the
 * exact recipe-owner partition stays private to the preparation operation. */
export function composeManagedMachinePresetPreparationBuildInputV1(params:
  Pick<ManagedMachinePresetPreparationBuildInputV1, 'launch' | 'cli'> & Readonly<{
    operationId: string;
    setup?: ManagedMachinePresetPreparationSetupV1;
  }>,
): ManagedMachinePresetPreparationBuildCompositionV1 {
  const { preparation, ...setup } = params.setup ?? {};
  if (preparation && preparation.basis.operationId !== params.operationId) {
    throw new Error('Setup preparation belongs to a different admitted build operation');
  }
  return { input: { launch: { provider: params.launch.provider, schemaVersion: params.launch.schemaVersion,
    choices: params.launch.choices }, cli: params.cli,
    ...(preparation ? { setupScript: buildMachineSetupPreparationCommandV1({ binaryPath: params.cli.binaryPath, preparation }) } : {}) },
    ...setup };
}
