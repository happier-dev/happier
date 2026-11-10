import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

const NonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

function deriveMentionable(input: Readonly<{
  enabled?: boolean;
  installed?: boolean;
  mentionable?: boolean;
}>): boolean {
  return input.mentionable ?? (input.installed === true && input.enabled === true);
}

export const VendorPluginCatalogItemV1Schema = lazyZodSchema(() => z.pipe(z.looseObject({
    v: z.literal(1),
    backendId: NonEmptyStringSchema,
    agentId: z.optional(NonEmptyStringSchema),
    vendorPluginRef: NonEmptyStringSchema,
    displayName: NonEmptyStringSchema,
    description: z.optional(NonEmptyStringSchema),
    marketplaceId: z.optional(NonEmptyStringSchema),
    installed: z.optional(z.boolean()),
    enabled: z.optional(z.boolean()),
    mentionable: z.optional(z.boolean()),
    defaultEnabled: z.optional(z.boolean()),
    capabilities: z.optional(z.readonly(z.array(NonEmptyStringSchema))),
    updatedAt: z.optional(z.number()),
  }), z.transform((item) => ({
    ...item,
    mentionable: deriveMentionable(item),
  }))));
export type VendorPluginCatalogItemV1 = z.output<typeof VendorPluginCatalogItemV1Schema>;

export const VendorPluginCatalogV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    backendId: NonEmptyStringSchema,
    agentId: z.optional(NonEmptyStringSchema),
    updatedAt: z.number(),
    items: z.readonly(z.array(VendorPluginCatalogItemV1Schema)),
  }));
export type VendorPluginCatalogV1 = z.output<typeof VendorPluginCatalogV1Schema>;
