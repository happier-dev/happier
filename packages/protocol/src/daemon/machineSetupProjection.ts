import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginMachineExecutionOriginV1Schema } from '../machines/administration/pluginMachineExecutionOriginV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginUiRuntimeOccurrenceIdV1Schema } from '../plugins/ui/runtimeOccurrenceV1.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { MachineRecipeV1Schema } from '../plugins/contributions/machineRecipes.js';
import { MachineSetupPresetContributionV1Schema } from '../plugins/contributions/machineSetupPresets.js';
import { validateProjectedExecutionOrigin } from './projectedExecutionOrigin.js';
import { PluginProjectionSourceV2Schema, PluginProjectionBrandAssetV2Schema } from './pluginCatalogPresentation.js';

/** Cold setup projections are also consumed by Actions without full discovery. */
function machineSetupDataEntrySchema<TDefinition extends { id: string }>(definition: z.ZodMiniType<TDefinition>) {
  return z.strictObject({
    id: z.string().check(z.minLength(1)), pluginId: asProtocolZod(PluginIdSchema), pluginVersion: z.string().check(z.minLength(1)),
    occurrenceId: z.optional(asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema)), executionOrigin: z.optional(PluginMachineExecutionOriginV1Schema),
    definition,
  }).check(z.superRefine((entry, context) => {
    if (entry.id !== `${entry.pluginId}/${entry.definition.id}`) context.addIssue({ code: 'custom', path: ['id'], message: 'Machine setup identity must match its declaration' });
    if (entry.executionOrigin && !entry.occurrenceId) context.addIssue({ code: 'custom', path: ['occurrenceId'], message: 'Machine setup origin requires its serving occurrence' });
    validateProjectedExecutionOrigin(entry.executionOrigin, entry, context);
  }));
}

export const PluginProjectedMachineRecipeEntryV1Schema = lazyZodSchema(() => z.safeExtend(machineSetupDataEntrySchema(MachineRecipeV1Schema), {
  source: z.optional(PluginProjectionSourceV2Schema), brand: z.optional(PluginProjectionBrandAssetV2Schema),
}));
export const PluginProjectedMachineSetupPresetEntryV1Schema = lazyZodSchema(() => machineSetupDataEntrySchema(MachineSetupPresetContributionV1Schema));
export type PluginProjectedMachineRecipeEntryV1 = z.infer<typeof PluginProjectedMachineRecipeEntryV1Schema>;
export type PluginProjectedMachineSetupPresetEntryV1 = z.infer<typeof PluginProjectedMachineSetupPresetEntryV1Schema>;
