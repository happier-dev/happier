import { z } from 'zod/mini';
import { MachineRecipeReferenceV1Schema } from '../machines/setup/machineRecipeV1.js';
import { MachineSetupToolchainSoftwareChoiceV1Schema } from '../plugins/contributions/projectNativeAdapters.js';

export const MachineSetupSoftwareChoiceV1Schema = z.union([
  MachineRecipeReferenceV1Schema, MachineSetupToolchainSoftwareChoiceV1Schema,
]);
export type MachineSetupSoftwareChoiceV1 = z.infer<typeof MachineSetupSoftwareChoiceV1Schema>;
