import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginContributionReferenceV2Schema, PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const PluginScmOperationV2Schema = lazyZodSchema(() => z.enum(['detect', 'clone', 'fetch', 'status', 'diff', 'commit', 'push', 'pullRequest']));
export const PluginScmOperationsV2Schema = lazyZodSchema(() => z.array(PluginScmOperationV2Schema).check(z.minLength(1, 'SCM contributions must declare at least one operation.'), z.superRefine((operations, ctx) => {
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
  })));
export const ScmHostingProviderContributionSchema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: zMini.optional(PluginLocalizedStringV2Schema),
  kind: z.string().check(z.trim(), z.minLength(1)),
  capabilities: PluginScmOperationsV2Schema,
  authService: zMini.optional(asProtocolZod(PluginContributionReferenceV2Schema)),
  /** Read-only Action resolving an exact repository ref to immutable commit provenance. */
  resolveRefAction: zMini.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type ScmHostingProviderContribution = z.infer<typeof ScmHostingProviderContributionSchema>;
