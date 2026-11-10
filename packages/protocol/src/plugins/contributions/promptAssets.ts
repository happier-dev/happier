import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
} from './publicTypes.js';

export const PluginPromptAssetContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  kind: z.enum(['systemPrompt', 'context', 'guidelines']),
  resource: asProtocolZod(PluginContributionReferenceV2Schema),
  target: z.strictObject({ kind: z.literal('agent'), agent: asProtocolZod(PluginContributionReferenceV2Schema) }),
  priority: z.optional(z.number().check(z.int())),
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type PluginPromptAssetContributionV1 = z.infer<typeof PluginPromptAssetContributionV1Schema>;
