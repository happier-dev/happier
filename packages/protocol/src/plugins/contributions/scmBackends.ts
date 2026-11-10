import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { PluginScmOperationsV2Schema } from './scmHostingProviders.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const ScmBackendContributionSchema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  kind: z.string().check(z.trim(), z.minLength(1)),
  capabilities: PluginScmOperationsV2Schema,
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type ScmBackendContribution = z.infer<typeof ScmBackendContributionSchema>;
