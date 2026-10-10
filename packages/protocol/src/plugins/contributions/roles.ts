import { lazyZodSchema } from '../../lazyZodSchema.js';
import { RoleArtifactV1Schema } from '../../prompts/roles/roleArtifactV1.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import type { z } from 'zod';

/** Declarative role text uses the role owner; only its manifest identity differs. */
export const PluginRoleDeclarationV1Schema = lazyZodSchema(() => RoleArtifactV1Schema.extend({
  id: asProtocolZod(PluginContributionLocalIdSchema),
}).strict());
export type PluginRoleDeclarationV1 = z.infer<typeof PluginRoleDeclarationV1Schema>;
