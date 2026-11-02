import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';

// Schema construction must not import semantic admission and its contribution catalog.
/** Read-only plugin definitions use the same grammar as library workflows. */
export const PluginWorkflowContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: z.string().check(z.trim(), z.minLength(1)),
  description: z.optional(z.string()),
  definition: WorkflowDefinitionV1Schema,
}));
export type PluginWorkflowContributionV1 = z.infer<typeof PluginWorkflowContributionV1Schema>;
