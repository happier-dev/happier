import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MACHINE_PRESET_ACTION_IDS_V1, type MachinePresetActionIdV1 } from './machinePresetActionIdsV1.js';
import {
  ManagedMachinePresetCreateInputV1Schema, ManagedMachinePresetGetInputV1Schema,
  ManagedMachinePresetGetResultV1Schema, ManagedMachinePresetListInputV1Schema,
  ManagedMachinePresetListResultV1Schema, ManagedMachinePresetRevisionInputV1Schema,
  ManagedMachinePresetUpdateInputV1Schema, PresetMutationResultV1Schema,
} from './managedMachinePresetV1.js';

export { MACHINE_PRESET_ACTION_IDS_V1, type MachinePresetActionIdV1 } from './machinePresetActionIdsV1.js';
export const MachinePresetActionIdV1Schema = lazyZodSchema(() => z.enum(MACHINE_PRESET_ACTION_IDS_V1));
export const MachinePresetActionInputSchemasV1 = {
  'machines.presets.list': ManagedMachinePresetListInputV1Schema,
  'machines.presets.get': ManagedMachinePresetGetInputV1Schema,
  'machines.presets.create': ManagedMachinePresetCreateInputV1Schema,
  'machines.presets.update': ManagedMachinePresetUpdateInputV1Schema,
  'machines.presets.archive': ManagedMachinePresetRevisionInputV1Schema,
  'machines.presets.restore': ManagedMachinePresetRevisionInputV1Schema,
} as const satisfies Record<MachinePresetActionIdV1, z.ZodType>;
export const MachinePresetActionOutputSchemasV1 = {
  'machines.presets.list': ManagedMachinePresetListResultV1Schema,
  'machines.presets.get': ManagedMachinePresetGetResultV1Schema,
  'machines.presets.create': PresetMutationResultV1Schema,
  'machines.presets.update': PresetMutationResultV1Schema,
  'machines.presets.archive': PresetMutationResultV1Schema,
  'machines.presets.restore': PresetMutationResultV1Schema,
} as const satisfies Record<MachinePresetActionIdV1, z.ZodType>;
export type MachinePresetActionInputV1<T extends MachinePresetActionIdV1 = MachinePresetActionIdV1> =
  z.infer<typeof MachinePresetActionInputSchemasV1[T]>;
export type MachinePresetActionOutputV1<T extends MachinePresetActionIdV1 = MachinePresetActionIdV1> =
  z.infer<typeof MachinePresetActionOutputSchemasV1[T]>;
export function machinePresetActionEndpointPathV1(actionId: MachinePresetActionIdV1): string {
  return `/v1/machines/presets/${actionId.slice('machines.presets.'.length)}`;
}
