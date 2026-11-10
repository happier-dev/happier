import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/** Addressing and caller authority are supplied by the mounted host. */
export const PluginLiveStreamReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plugin'), source: asProtocolZod(PluginContributionIdentityV1Schema) }),
  z.strictObject({ kind: z.literal('host'), sourceId: z.string().check(z.trim(), z.minLength(1)) }),
]));
export type PluginLiveStreamReferenceV1 = z.infer<typeof PluginLiveStreamReferenceV1Schema>;
export const PluginUiWatchLiveStreamRequestV1Schema = lazyZodSchema(() => z.strictObject({
  reference: PluginLiveStreamReferenceV1Schema,
  subscriptionId: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginUiWatchLiveStreamRequestV1 = z.infer<typeof PluginUiWatchLiveStreamRequestV1Schema>;
export const PluginUiLiveStreamViewingV1Schema = lazyZodSchema(() => z.strictObject({
  subscriptionId: z.string().check(z.trim(), z.minLength(1)),
  kind: z.literal('ready'),
}));
export type PluginUiLiveStreamViewingV1 = z.infer<typeof PluginUiLiveStreamViewingV1Schema>;
