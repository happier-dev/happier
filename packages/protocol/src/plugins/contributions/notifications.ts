import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginSettingFieldV2Schema } from './settings.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';

const DisplayBaseSchema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
});

export const PluginNotificationCategoryKindV1Schema = z.enum([
  'activity',
  'approval',
  'plugin',
]);
export type PluginNotificationCategoryKindV1 = z.infer<typeof PluginNotificationCategoryKindV1Schema>;

export const PluginNotificationChannelKindV1Schema = z.enum([
  'expo_push',
  'webhook',
  'local_notification',
  'badge',
  'desktop_overlay',
  'live_activity',
  'home_widget',
  'plugin',
]);
export type PluginNotificationChannelKindV1 = z.infer<typeof PluginNotificationChannelKindV1Schema>;

export const PluginNotificationCategoryContributionV2Schema = DisplayBaseSchema.extend({
  kind: PluginNotificationCategoryKindV1Schema,
  eventIds: z.array(PluginContributionReferenceV2Schema),
  defaultChannels: z.array(PluginContributionReferenceV2Schema).optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
}).strict();
export type PluginNotificationCategoryContributionV2 = z.infer<typeof PluginNotificationCategoryContributionV2Schema>;

export const PluginNotificationChannelContributionV2Schema = DisplayBaseSchema.extend({
  kind: PluginNotificationChannelKindV1Schema,
  configurable: z.boolean().optional(),
  defaultEnabled: z.boolean().optional(),
  settings: z.array(PluginSettingFieldV2Schema).optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
}).strict();
export type PluginNotificationChannelContributionV2 = z.infer<typeof PluginNotificationChannelContributionV2Schema>;
