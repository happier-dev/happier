import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PromptAssetTypeDescriptorV1Schema } from '../../prompts/library/promptAssetDescriptorsV1.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
} from './publicTypes.js';

export const PluginPromptAssetContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  kind: z.enum(['systemPrompt', 'context', 'guidelines']),
  resource: asProtocolZod(PluginContributionReferenceV2Schema),
  target: z.object({ kind: z.literal('agent'), agent: asProtocolZod(PluginContributionReferenceV2Schema) }).strict(),
  priority: z.number().int().optional(),
  adapterDescriptor: PromptAssetTypeDescriptorV1Schema.optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginPromptAssetContributionV1 = z.infer<typeof PluginPromptAssetContributionV1Schema>;
