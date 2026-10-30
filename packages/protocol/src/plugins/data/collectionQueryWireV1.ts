import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginCollectionFiniteNumberV1Schema } from './collectionContributionV1.js';
import { PluginCollectionOpaqueCursorV1Schema } from './collectionOpaqueCursorV1.js';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from './collectionLimitsV1.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/** Logical operands shared by the authenticated and hosted Collection adapters. */
export const PluginCollectionIndexScalarValueV1Schema = lazyZodSchema(() => z.union([
  z.null(), z.boolean(), z.string(), PluginCollectionFiniteNumberV1Schema,
]));
export type PluginCollectionIndexScalarValueV1 = z.infer<typeof PluginCollectionIndexScalarValueV1Schema>;

export const PluginCollectionQueryRangeV1Schema = lazyZodSchema(() => z.strictObject({
  lower: z.optional(PluginCollectionIndexScalarValueV1Schema),
  upper: z.optional(PluginCollectionIndexScalarValueV1Schema),
}).check(z.refine(value => value.lower !== undefined || value.upper !== undefined,
  'A collection query range needs a lower or upper bound.')));
export type PluginCollectionQueryRangeV1 = z.infer<typeof PluginCollectionQueryRangeV1Schema>;

export function pluginCollectionQueryShapeV1() {
  return {
    prefix: z._default(z.array(PluginCollectionIndexScalarValueV1Schema).check(z.maxLength(4)), []),
    prefixes: z.optional(z.array(z.array(PluginCollectionIndexScalarValueV1Schema).check(z.maxLength(4)))),
    range: z.optional(PluginCollectionQueryRangeV1Schema),
    order: z.enum(['asc', 'desc']),
    cursor: z.optional(asProtocolZod(PluginCollectionOpaqueCursorV1Schema)),
    limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1)), 50),
  };
}

export function isPluginCollectionQuerySelectionV1(value: Readonly<{
  prefix: readonly unknown[]; prefixes?: readonly (readonly unknown[])[];
}>): boolean {
  return value.prefixes === undefined || value.prefix.length === 0;
}
