import { z } from 'zod';

import { BrowserProfileStorageModeV1Schema } from '../../../browser/profile/v1.js';
import { BrowserHttpUrlV1Schema } from '../../../browser/url.js';
import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { PluginAvailabilityDescriptorV2Schema, PluginContributionReferenceV2Schema, PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from '../publicTypes.js';

const DisplayShape = {
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
};
export const PluginBrowserTargetContributionV1Schema = z.object({
  ...DisplayShape,
  url: BrowserHttpUrlV1Schema,
  launch: z.enum(['newView', 'currentView']).default('newView'),
  profile: BrowserProfileStorageModeV1Schema.default('user'),
}).strict();
export type PluginBrowserTargetContributionInputV1 = z.input<typeof PluginBrowserTargetContributionV1Schema>;
export type PluginBrowserTargetContributionV1 = z.infer<typeof PluginBrowserTargetContributionV1Schema>;
export const PluginBrowserActionContributionV1Schema = z.object({
  ...DisplayShape,
  action: PluginContributionReferenceV2Schema,
  target: PluginContributionReferenceV2Schema,
  placement: z.enum(['toolbar', 'detailsPanel', 'contextMenu']).default('toolbar'),
  icon: z.string().trim().regex(/^[a-z][a-z0-9.-]*$/i).optional(),
  order: z.number().int().optional(),
}).strict();
export type PluginBrowserActionContributionInputV1 = z.input<typeof PluginBrowserActionContributionV1Schema>;
export type PluginBrowserActionContributionV1 = z.infer<typeof PluginBrowserActionContributionV1Schema>;
