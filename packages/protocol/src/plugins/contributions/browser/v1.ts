import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';

import { BrowserProfileStorageModeV1Schema } from '../../../browser/profile/v1.js';
import { BrowserHttpUrlV1Schema } from '../../../browser/url.js';
import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { PluginAvailabilityDescriptorV2Schema, PluginContributionReferenceV2Schema, PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from '../publicTypes.js';

const DisplayShape = {
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
};
export const PluginBrowserTargetContributionV1Schema = lazyZodSchema(() => z.strictObject({
  ...DisplayShape,
  url: BrowserHttpUrlV1Schema,
  launch: z._default(z.enum(['newView', 'currentView']), 'newView'),
  profile: z._default(BrowserProfileStorageModeV1Schema, 'user'),
}));
export type PluginBrowserTargetContributionInputV1 = z.input<typeof PluginBrowserTargetContributionV1Schema>;
export type PluginBrowserTargetContributionV1 = z.infer<typeof PluginBrowserTargetContributionV1Schema>;
export const PluginBrowserActionContributionV1Schema = lazyZodSchema(() => z.strictObject({
  ...DisplayShape,
  action: asProtocolZod(PluginContributionReferenceV2Schema),
  target: asProtocolZod(PluginContributionReferenceV2Schema),
  placement: z._default(z.enum(['toolbar', 'detailsPanel', 'contextMenu']), 'toolbar'),
  icon: z.optional(z.string().check(z.trim(), z.regex(/^[a-z][a-z0-9.-]*$/i))),
  order: z.optional(z.number().check(z.int())),
}));
export type PluginBrowserActionContributionInputV1 = z.input<typeof PluginBrowserActionContributionV1Schema>;
export type PluginBrowserActionContributionV1 = z.infer<typeof PluginBrowserActionContributionV1Schema>;
