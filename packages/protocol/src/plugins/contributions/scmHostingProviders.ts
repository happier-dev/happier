import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginContributionReferenceV2Schema, PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';

export const PluginScmOperationV2Schema = z.enum(['detect', 'clone', 'fetch', 'status', 'diff', 'commit', 'push', 'pullRequest']);
export const PluginScmOperationsV2Schema = z.array(PluginScmOperationV2Schema)
  .min(1, 'SCM contributions must declare at least one operation.')
  .superRefine((operations, ctx) => {
    const seen = new Set<string>();
    operations.forEach((operation, index) => {
      if (seen.has(operation)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `Duplicate SCM operation '${operation}'.`,
        });
      }
      seen.add(operation);
    });
  });
export const ScmHostingProviderContributionSchema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  kind: z.string().trim().min(1),
  capabilities: PluginScmOperationsV2Schema,
  authService: PluginContributionReferenceV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type ScmHostingProviderContribution = z.infer<typeof ScmHostingProviderContributionSchema>;
