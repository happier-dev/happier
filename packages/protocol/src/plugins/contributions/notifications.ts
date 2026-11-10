import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginSettingFieldV2Schema } from './settings.js';
import { PluginDeclarativeButtonsV1Schema } from './declarativeButtonsV1.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';

const DisplayBaseSchema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));

export const PluginNotificationCategoryKindV1Schema = lazyZodSchema(() => z.enum([
  'activity',
  'approval',
  'plugin',
]));
export type PluginNotificationCategoryKindV1 = z.infer<typeof PluginNotificationCategoryKindV1Schema>;

export const PluginNotificationChannelKindV1Schema = lazyZodSchema(() => z.enum([
  'expo_push',
  'webhook',
  'local_notification',
  'badge',
  'desktop_overlay',
  'live_activity',
  'home_widget',
  'plugin',
]));
export type PluginNotificationChannelKindV1 = z.infer<typeof PluginNotificationChannelKindV1Schema>;

export const PluginNotificationCategoryContributionV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DisplayBaseSchema, {
  kind: PluginNotificationCategoryKindV1Schema,
  eventIds: z.array(asProtocolZod(PluginContributionReferenceV2Schema)),
  defaultChannels: z.optional(z.array(asProtocolZod(PluginContributionReferenceV2Schema))),
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
  buttons: z.optional(PluginDeclarativeButtonsV1Schema),
})));
export type PluginNotificationCategoryContributionV2 = z.infer<typeof PluginNotificationCategoryContributionV2Schema>;

export const PluginNotificationChannelContributionV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DisplayBaseSchema, {
  kind: PluginNotificationChannelKindV1Schema,
  configurable: z.optional(z.boolean()),
  defaultEnabled: z.optional(z.boolean()),
  settings: z.optional(z.array(PluginSettingFieldV2Schema)),
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
})));
export type PluginNotificationChannelContributionV2 = z.infer<typeof PluginNotificationChannelContributionV2Schema>;
