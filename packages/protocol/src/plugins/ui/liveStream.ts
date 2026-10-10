import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/** Addressing and caller authority are supplied by the mounted host. */
export const PluginLiveStreamReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plugin'), source: asProtocolZod(PluginContributionIdentityV1Schema) }).strict(),
  z.object({ kind: z.literal('host'), sourceId: z.string().trim().min(1) }).strict(),
]));
export type PluginLiveStreamReferenceV1 = z.infer<typeof PluginLiveStreamReferenceV1Schema>;
export const PluginUiWatchLiveStreamRequestV1Schema = lazyZodSchema(() => z.object({
  reference: PluginLiveStreamReferenceV1Schema,
  subscriptionId: z.string().trim().min(1),
}).strict());
export type PluginUiWatchLiveStreamRequestV1 = z.infer<typeof PluginUiWatchLiveStreamRequestV1Schema>;
export const PluginUiLiveStreamViewingV1Schema = lazyZodSchema(() => z.object({
  subscriptionId: z.string().trim().min(1),
  kind: z.literal('ready'),
}).strict());
export type PluginUiLiveStreamViewingV1 = z.infer<typeof PluginUiLiveStreamViewingV1Schema>;
