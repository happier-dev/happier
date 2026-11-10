import '../../zodRuntimePolicy.js';
import { z } from 'zod';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';

/** A qualified recipe reference carries no setup inputs or effect authority. */
export const MachineRecipeReferenceV1Schema = z.object({
    pluginId: asProtocolZod(PluginIdSchema), recipeId: asProtocolZod(PluginContributionLocalIdSchema), revision: z.string().min(1),
}).strict();
export type MachineRecipeReferenceV1 = z.infer<typeof MachineRecipeReferenceV1Schema>;

/**
 * The bundled Docker Engine recipe: what a Machine needs to host Compose deployments. The recipes plugin declares
 * its recipe under this reference and the deployment draft plans it, so neither copies the other's ids.
 */
export const DOCKER_ENGINE_RECIPE_REF_V1 = Object.freeze({
    pluginId: 'happier.machine.recipes', recipeId: 'docker-engine', revision: '1',
} as const) satisfies MachineRecipeReferenceV1;

/** Shared receiver selection for native setup and the deployment configure composition. */
export const BACKUP_RECEIVER_RECIPE_REF_V1 = Object.freeze({
    pluginId: 'happier.machine.recipes', recipeId: 'backup-receiver', revision: '1',
} as const) satisfies MachineRecipeReferenceV1;
