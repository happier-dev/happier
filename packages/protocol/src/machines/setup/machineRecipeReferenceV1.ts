import { z } from 'zod';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';

/** A qualified recipe reference carries no setup inputs or effect authority. */
export const MachineRecipeReferenceV1Schema = z.object({
    pluginId: asProtocolZod(PluginIdSchema), recipeId: asProtocolZod(PluginContributionLocalIdSchema), revision: z.string().min(1),
}).strict();
export type MachineRecipeReferenceV1 = z.infer<typeof MachineRecipeReferenceV1Schema>;
