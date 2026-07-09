import { z } from 'zod';

import { PluginSessionResourceTargetV1Schema } from '../contributions/ui/resources.js';
import { PluginUiResourceSnapshotV1Schema } from './resourceSnapshots.js';

export const PluginUiResourceSubscriptionRequestV1Schema = z.object({
  subscriptionId: z.string().trim().min(1),
  resource: PluginSessionResourceTargetV1Schema,
}).strict();
export type PluginUiResourceSubscriptionRequestV1 =
  z.infer<typeof PluginUiResourceSubscriptionRequestV1Schema>;

export const PluginUiResourceUnsubscribeRequestV1Schema = z.object({
  subscriptionId: z.string().trim().min(1),
}).strict();
export type PluginUiResourceUnsubscribeRequestV1 =
  z.infer<typeof PluginUiResourceUnsubscribeRequestV1Schema>;

export const PluginUiResourceSubscriptionEventV1Schema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(1),
    subscriptionId: z.string().trim().min(1),
    kind: z.literal('snapshot'),
    snapshot: PluginUiResourceSnapshotV1Schema,
  }).strict(),
  z.object({
    version: z.literal(1),
    subscriptionId: z.string().trim().min(1),
    kind: z.literal('complete'),
    diagnostics: z.array(z.string().trim().min(1)).default([]),
  }).strict(),
  z.object({
    version: z.literal(1),
    subscriptionId: z.string().trim().min(1),
    kind: z.literal('error'),
    code: z.enum(['unavailable', 'denied', 'stale_surface', 'expired_resource']),
    diagnostics: z.array(z.string().trim().min(1)).default([]),
  }).strict(),
]);
export type PluginUiResourceSubscriptionEventV1 =
  z.infer<typeof PluginUiResourceSubscriptionEventV1Schema>;
