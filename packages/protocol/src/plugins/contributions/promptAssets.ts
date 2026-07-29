import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
} from './publicTypes.js';

export const PluginPromptAssetContributionV1Schema = z.object({
  id: PluginContributionLocalIdSchema,
  kind: z.enum(['systemPrompt', 'context', 'guidelines']),
  resource: PluginContributionReferenceV2Schema,
  target: z.object({ kind: z.literal('agent'), agent: PluginContributionReferenceV2Schema }).strict(),
  priority: z.number().int().optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginPromptAssetContributionV1 = z.infer<typeof PluginPromptAssetContributionV1Schema>;
