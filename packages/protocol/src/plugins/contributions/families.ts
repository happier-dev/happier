import { z } from 'zod';

export type PluginContributionFamilyDescriptorV2<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = Readonly<{
  family: string;
  schema: TSchema;
}>;

export function definePluginContributionFamilyV2<TSchema extends z.ZodTypeAny>(
  descriptor: PluginContributionFamilyDescriptorV2<TSchema>,
): PluginContributionFamilyDescriptorV2<TSchema> {
  return Object.freeze(descriptor);
}

export function buildPluginContributionFamilySchemaV2(
  descriptors: readonly PluginContributionFamilyDescriptorV2[],
): z.ZodObject<Record<string, z.ZodDefault<z.ZodArray<z.ZodTypeAny>>>> {
  const shape: Record<string, z.ZodDefault<z.ZodArray<z.ZodTypeAny>>> = {};
  for (const descriptor of descriptors) {
    shape[descriptor.family] = z.array(descriptor.schema).default([]);
  }
  return z.object(shape).passthrough();
}
