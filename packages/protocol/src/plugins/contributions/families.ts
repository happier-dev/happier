import { z } from 'zod';

export type PluginContributionFamilyDescriptorV2<
  TFamily extends string = string,
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
> = Readonly<{
  family: TFamily;
  schema: TSchema;
  maxItems?: number;
}>;

export function definePluginContributionFamilyV2<
  const TFamily extends string,
  TSchema extends z.ZodTypeAny,
>(
  descriptor: PluginContributionFamilyDescriptorV2<TFamily, TSchema>,
): PluginContributionFamilyDescriptorV2<TFamily, TSchema> {
  return Object.freeze(descriptor);
}

type PluginContributionFamilyShapeV2<
  TDescriptors extends readonly PluginContributionFamilyDescriptorV2[],
> = {
  [TDescriptor in TDescriptors[number] as TDescriptor['family']]: z.ZodDefault<
    z.ZodArray<TDescriptor['schema']>
  >;
};

export function buildPluginContributionFamilySchemaV2<
  const TDescriptors extends readonly PluginContributionFamilyDescriptorV2[],
>(
  descriptors: TDescriptors,
): z.ZodObject<PluginContributionFamilyShapeV2<TDescriptors>> {
  const shape: Record<string, z.ZodDefault<z.ZodArray<z.ZodTypeAny>>> = {};
  for (const descriptor of descriptors) {
    const items = z.array(descriptor.schema);
    shape[descriptor.family] = (
      descriptor.maxItems === undefined ? items : items.max(descriptor.maxItems)
    ).default([]);
  }
  return z.object(shape).strict() as unknown as z.ZodObject<
    PluginContributionFamilyShapeV2<TDescriptors>
  >;
}
