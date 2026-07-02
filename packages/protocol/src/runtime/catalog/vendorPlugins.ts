import { z } from 'zod';

const NonEmptyStringSchema = z.string().trim().min(1);

function deriveMentionable(input: Readonly<{
  enabled?: boolean;
  installed?: boolean;
  mentionable?: boolean;
}>): boolean {
  return input.mentionable ?? (input.installed === true && input.enabled === true);
}

export const VendorPluginCatalogItemV1Schema = z
  .object({
    v: z.literal(1),
    backendId: NonEmptyStringSchema,
    agentId: NonEmptyStringSchema.optional(),
    vendorPluginRef: NonEmptyStringSchema,
    displayName: NonEmptyStringSchema,
    description: NonEmptyStringSchema.optional(),
    marketplaceId: NonEmptyStringSchema.optional(),
    installed: z.boolean().optional(),
    enabled: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    defaultEnabled: z.boolean().optional(),
    capabilities: z.array(NonEmptyStringSchema).readonly().optional(),
    updatedAt: z.number().finite().optional(),
  })
  .passthrough()
  .transform((item) => ({
    ...item,
    mentionable: deriveMentionable(item),
  }));
export type VendorPluginCatalogItemV1 = z.output<typeof VendorPluginCatalogItemV1Schema>;

export const VendorPluginCatalogV1Schema = z
  .object({
    v: z.literal(1),
    backendId: NonEmptyStringSchema,
    agentId: NonEmptyStringSchema.optional(),
    updatedAt: z.number().finite(),
    items: z.array(VendorPluginCatalogItemV1Schema).readonly(),
  })
  .passthrough();
export type VendorPluginCatalogV1 = z.output<typeof VendorPluginCatalogV1Schema>;
