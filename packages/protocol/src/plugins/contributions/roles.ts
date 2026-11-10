import { lazyZodSchema } from '../../lazyZodSchema.js';
import { RoleArtifactV1Schema } from '../../prompts/roles/roleArtifactV1.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { z } from '../../zodRuntimePolicy.js';

/** Declarative role text uses the role owner; only its manifest identity differs. */
export const PluginRoleDeclarationV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RoleArtifactV1Schema, {
  id: asProtocolZod(PluginContributionLocalIdSchema),
})));
export type PluginRoleDeclarationV1 = z.infer<typeof PluginRoleDeclarationV1Schema>;
