import { z } from 'zod';

import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';
import {
  PluginContributionLocalIdSchema,
  type PluginContributionLocalId,
} from '../../contributionIdentity.js';
import { PluginAvailabilityDescriptorV2Schema } from '../publicTypes.js';

/** A Resource-backed declarative document mounted inline in Session info. */
export const PluginSessionInfoSectionContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  resourceId: asProtocolZod(PluginContributionLocalIdSchema),
  order: z.number().int().optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  actions: z.array(asProtocolZod(PluginContributionLocalIdSchema))
    .max(32)
    .refine((values) => new Set(values).size === values.length, 'Entries must be unique.')
    .default([]),
}).strict();

export type PluginSessionInfoSectionContributionV1 = z.infer<
  typeof PluginSessionInfoSectionContributionV1Schema
>;

/** Canonical synthetic declarative-renderer identity for one Session-info section. */
export function createPluginSessionInfoSectionRendererIdV1(
  sectionId: PluginContributionLocalId,
): PluginContributionLocalId {
  return PluginContributionLocalIdSchema.parse(`session-info-${sectionId}`);
}
