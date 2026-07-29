import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { PluginScmOperationsV2Schema } from './scmHostingProviders.js';

export const ScmBackendContributionSchema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  kind: z.string().trim().min(1),
  capabilities: PluginScmOperationsV2Schema,
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type ScmBackendContribution = z.infer<typeof ScmBackendContributionSchema>;
