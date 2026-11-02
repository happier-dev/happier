import { z } from 'zod/mini';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '../../actions/protocolComposableSchema.js';

const ResourceKindProtocolSchema = defineProtocolUnion([
  defineProtocolLiteral('pullRequest'), defineProtocolLiteral('issue'),
  defineProtocolLiteral('ciRun'), defineProtocolLiteral('securityAlert'),
]);
export const PluginUiResourceKindV1Schema = lazyZodSchema(() => asProtocolZod(ResourceKindProtocolSchema));
export const PluginUiResourceIntentV1Schema = defineProtocolObject({
  kind: ResourceKindProtocolSchema,
  url: defineProtocolString({ minLength: 1, pattern: '^https?://' }),
}, { policy: 'closed' });
export type PluginUiResourceIntentV1 = ReturnType<typeof PluginUiResourceIntentV1Schema.parse>;

/** Integration-owned recognition and same-plugin destination, carried by its declared UI view. */
export const PluginUiResourceLinkV1Schema = lazyZodSchema(() => z.strictObject({
  kind: PluginUiResourceKindV1Schema,
  urlPattern: z.string().check(z.refine(value => {
    try { new RegExp(value); return true; } catch { return false; }
  }, 'Resource URL pattern must be a regular expression.')),
  destination: asProtocolZod(PluginContributionLocalIdSchema),
}));
export type PluginUiResourceLinkV1 = z.infer<typeof PluginUiResourceLinkV1Schema>;
