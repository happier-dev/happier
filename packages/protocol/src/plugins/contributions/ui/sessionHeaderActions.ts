import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { PluginAvailabilityDescriptorV2Schema, PluginContributionReferenceV2Schema, PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from '../publicTypes.js';

export const PluginSessionHeaderActionDescriptorV1Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  action: PluginContributionReferenceV2Schema,
  order: z.number().int().optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginSessionHeaderActionDescriptorV1 = z.infer<typeof PluginSessionHeaderActionDescriptorV1Schema>;
export type PluginSessionHeaderActionDescriptor = z.infer<typeof PluginSessionHeaderActionDescriptorV1Schema>;
export type PluginSessionHeaderActionDescriptorInput = z.input<typeof PluginSessionHeaderActionDescriptorV1Schema>;
