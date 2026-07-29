import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from '../publicTypes.js';

export const PluginJsonSchemaV1Schema = PluginJsonSchemaV2Schema;
export type PluginJsonSchemaV1 = z.infer<typeof PluginJsonSchemaV2Schema>;

export const MAX_PLUGIN_STRUCTURED_MESSAGE_REFERENCES_V1 = 64;

export const PluginStructuredMessageDescriptorV1Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  kind: z.string().trim().min(1),
  payloadSchema: PluginJsonSchemaV2Schema,
  renderer: PluginContributionLocalIdSchema,
  actions: z.array(PluginContributionReferenceV2Schema)
    .max(MAX_PLUGIN_STRUCTURED_MESSAGE_REFERENCES_V1)
    .optional(),
  fallback: z.union([
    z.object({ kind: z.literal('summary'), template: z.string() }).strict(),
    z.object({ kind: z.literal('hidden') }).strict(),
  ]),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginStructuredMessageDescriptorV1 = z.infer<typeof PluginStructuredMessageDescriptorV1Schema>;
export type PluginStructuredMessageDescriptor = z.infer<typeof PluginStructuredMessageDescriptorV1Schema>;
export type PluginStructuredMessageDescriptorInput = z.input<typeof PluginStructuredMessageDescriptorV1Schema>;
