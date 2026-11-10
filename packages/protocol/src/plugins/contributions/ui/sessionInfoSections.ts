import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';
import {
  PluginContributionLocalIdSchema,
  type PluginContributionLocalId,
} from '../../contributionIdentity.js';
import { PluginAvailabilityDescriptorV2Schema } from '../publicTypes.js';

/** A Resource-backed declarative document mounted inline in Session info. */
export const PluginSessionInfoSectionContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  resourceId: asProtocolZod(PluginContributionLocalIdSchema),
  order: z.optional(z.number().check(z.int())),
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
  actions: z._default(z.array(asProtocolZod(PluginContributionLocalIdSchema)).check(z.maxLength(32), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')), []),
}));

export type PluginSessionInfoSectionContributionV1 = z.infer<
  typeof PluginSessionInfoSectionContributionV1Schema
>;

/** Canonical synthetic declarative-renderer identity for one Session-info section. */
export function createPluginSessionInfoSectionRendererIdV1(
  sectionId: PluginContributionLocalId,
): PluginContributionLocalId {
  return PluginContributionLocalIdSchema.parse(`session-info-${sectionId}`);
}
