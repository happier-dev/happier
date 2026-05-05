import { z } from 'zod';

import { PluginLooseJsonObjectSchema, PluginOptionalStringSchema } from '../_shared.js';

export const PluginNotificationCategoryKindV1Schema = z.enum(['activity', 'approval', 'plugin']);
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

export const PluginNotificationCategoryContributionV2Schema = z.object({
  id: z.string().trim().min(1),
  kind: PluginNotificationCategoryKindV1Schema,
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  eventIds: z.array(z.string().trim().min(1)).default([]),
  defaultChannelIds: z.array(z.string().trim().min(1)).default([]),
  featureGate: PluginOptionalStringSchema,
  metadata: PluginLooseJsonObjectSchema.optional(),
}).strict();
export type PluginNotificationCategoryContributionV2 = z.infer<typeof PluginNotificationCategoryContributionV2Schema>;

export const PluginNotificationChannelContributionV2Schema = z.object({
  id: z.string().trim().min(1),
  kind: PluginNotificationChannelKindV1Schema,
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  configurable: z.boolean().default(false),
  defaultEnabled: z.boolean().default(true),
  featureGate: PluginOptionalStringSchema,
  settingsSchema: PluginLooseJsonObjectSchema.optional(),
  credentialSchema: PluginLooseJsonObjectSchema.optional(),
  metadata: PluginLooseJsonObjectSchema.optional(),
}).strict();
export type PluginNotificationChannelContributionV2 = z.infer<typeof PluginNotificationChannelContributionV2Schema>;
