import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { PluginUiArtifactDigestV1Schema } from '../plugins/ui/artifactIntegrity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

/** Catalog source presentation is not source custody or execution authority. */
export const PluginProjectionSourceV2Schema = lazyZodSchema(() => z.strictObject({
  kind: z.string().check(z.trim(), z.minLength(1)),
  locator: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginProjectionSourceV2 = z.infer<typeof PluginProjectionSourceV2Schema>;

/** The admitted resource descriptor, never a path, URL, or byte handle. */
export const PluginProjectionBrandAssetV2Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    state: z.literal('available'),
    resource: asProtocolZod(PluginContributionIdentityV1Schema),
    monochrome: z.optional(z.boolean()),
    width: z.number().check(z.int(), z.minimum(64), z.maximum(512)),
    height: z.number().check(z.int(), z.minimum(64), z.maximum(512)),
    digest: PluginUiArtifactDigestV1Schema,
  }).check(z.refine((value) => value.width === value.height, {
    message: 'A plugin brand asset must be square',
  })),
  z.strictObject({ state: z.enum(['missing', 'invalid', 'retired']) }),
]));
export type PluginProjectionBrandAssetV2 = z.infer<typeof PluginProjectionBrandAssetV2Schema>;
