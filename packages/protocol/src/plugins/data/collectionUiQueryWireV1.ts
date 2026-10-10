import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  PluginCollectionFiniteNumberV1Schema,
  PluginCollectionMemberNameV1Schema,
  PluginCollectionProjectedScalarFieldRefV1Schema,
  PluginCollectionProjectedScalarValueV1Schema,
  PluginCollectionUiQueryParameterV1Schema,
  PluginCollectionUiQueryValueV1Schema,
} from './collectionContributionV1.js';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from './collectionLimitsV1.js';
import { PluginCollectionOpaqueCursorV1Schema } from './collectionOpaqueCursorV1.js';
import { PluginCollectionContractRefV1Schema } from './collectionContractRefV1.js';

export type { PluginCollectionProjectedScalarFieldRefV1 } from './collectionContributionV1.js';

const MAX_COLLECTION_ROW_ID_UTF8_BYTES = 256;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** A stable Data row identity shared by direct and UI-query wire contracts. */
export const PluginCollectionRowIdV1Schema = lazyZodSchema(() => z.string().min(1).superRefine((value, context) => {
  if (value.includes('\u0000')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Row ID must not contain NUL.' });
  }
  if (utf8ByteLength(value) > MAX_COLLECTION_ROW_ID_UTF8_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Row ID exceeds the 256-byte limit.' });
  }
}));
export type PluginCollectionRowIdV1 = z.infer<typeof PluginCollectionRowIdV1Schema>;

export { PluginCollectionOpaqueCursorV1Schema };

/**
 * The authenticated static UI-query request and result wire are realm-neutral:
 * Account qualification, contract admission, and private cursor ownership stay
 * with the direct Data client that consumes them.
 */
export const PluginCollectionUiQueryInputV1Schema = lazyZodSchema(() => z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  uiQueryId: PluginCollectionMemberNameV1Schema,
  parameters: z.record(
    PluginCollectionMemberNameV1Schema,
    z.union([z.string(), PluginCollectionFiniteNumberV1Schema, z.boolean()]),
  ).default({}),
  cursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
}).strict());
export type PluginCollectionUiQueryInputV1 = z.infer<typeof PluginCollectionUiQueryInputV1Schema>;

export const PluginCollectionUiQueryRequestV1Schema = lazyZodSchema(() => PluginCollectionUiQueryInputV1Schema.extend({
  readerContext: PluginCollectionContractRefV1Schema,
}).strict());
export type PluginCollectionUiQueryRequestV1 = z.infer<typeof PluginCollectionUiQueryRequestV1Schema>;

/**
 * Exact immutable UI-query descriptor emitted from a normalized collection
 * contract. Keeping this structural wire projection beside the UI request and
 * result avoids pulling the host-only Collection encryption codec into public
 * declarative Action consumers.
 */
export const NormalizedPluginCollectionUiQueryDescriptorV1Schema = lazyZodSchema(() => z.object({
  collection: z.object({
    pluginId: asProtocolZod(PluginIdSchema),
    collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
  id: PluginCollectionMemberNameV1Schema,
  indexId: PluginCollectionMemberNameV1Schema,
  parameters: z.record(PluginCollectionMemberNameV1Schema, PluginCollectionUiQueryParameterV1Schema),
  prefix: z.array(PluginCollectionUiQueryValueV1Schema).max(4),
  range: z.object({
    lower: PluginCollectionUiQueryValueV1Schema.optional(),
    upper: PluginCollectionUiQueryValueV1Schema.optional(),
  }).strict().refine((value) => value.lower !== undefined || value.upper !== undefined, 'A range needs a lower or upper bound.').optional(),
  order: z.enum(['asc', 'desc']),
  pageSize: z.number().int().min(1).max(PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1),
  projectedFields: z.array(PluginCollectionProjectedScalarFieldRefV1Schema).min(1).max(16),
}).strict().superRefine((value, context) => {
  if (new Set(value.projectedFields.map((field) => field.field)).size !== value.projectedFields.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['projectedFields'],
      message: 'Projected fields must be unique.',
    });
  }
}));
export type NormalizedPluginCollectionUiQueryDescriptorV1 = z.infer<
  typeof NormalizedPluginCollectionUiQueryDescriptorV1Schema
>;

export function isCanonicalPluginCollectionIndexedInstantV1(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
}

export function validatePluginCollectionUiQueryParametersV1(
  descriptor: NormalizedPluginCollectionUiQueryDescriptorV1,
  parameters: Readonly<Record<string, string | number | boolean>>,
): void {
  const known = descriptor.parameters;
  for (const key of Object.keys(parameters)) {
    if (!(key in known)) throw new Error(`UI query parameter "${key}" is not declared.`);
  }
  for (const [id, schema] of Object.entries(known)) {
    const value = parameters[id];
    if (value === undefined) throw new Error(`UI query parameter "${id}" is required.`);
    if (schema.kind === 'string') {
      if (typeof value !== 'string' || new TextEncoder().encode(value).length > schema.maxUtf8Bytes || (schema.enum && !schema.enum.includes(value))) {
        throw new Error(`UI query parameter "${id}" is invalid.`);
      }
    } else if (schema.kind === 'finiteNumber') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error(`UI query parameter "${id}" is invalid.`);
    } else if (schema.kind === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`UI query parameter "${id}" is invalid.`);
    } else if (schema.kind === 'instant' && (typeof value !== 'string' || !isCanonicalPluginCollectionIndexedInstantV1(value))) {
      throw new Error(`UI query parameter "${id}" is invalid.`);
    }
  }
}

export const PluginCollectionUiRowContextV1Schema = lazyZodSchema(() => z.object({
  collection: z.object({
    pluginId: asProtocolZod(PluginIdSchema),
    collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
  rowId: PluginCollectionRowIdV1Schema,
  revision: z.number().int().positive(),
}).strict());
export type PluginCollectionUiRowContextV1 = z.infer<typeof PluginCollectionUiRowContextV1Schema>;

const PluginCollectionUiRowFieldsV1Schema = lazyZodSchema(() => z.record(
  PluginCollectionMemberNameV1Schema,
  PluginCollectionProjectedScalarValueV1Schema,
).superRefine((value, context) => {
  if (Object.keys(value).length > 16) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A UI query row has too many projected fields.' });
  }
}));

export const PluginCollectionUiRowV1Schema = lazyZodSchema(() => z.object({
  context: PluginCollectionUiRowContextV1Schema,
  fields: PluginCollectionUiRowFieldsV1Schema,
}).strict());
export type PluginCollectionUiRowV1 = z.infer<typeof PluginCollectionUiRowV1Schema>;

export const PluginCollectionUiQueryResultV1Schema = lazyZodSchema(() => z.object({
  rows: z.array(PluginCollectionUiRowV1Schema).max(200),
  nextCursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
  changeCursor: z.number().int().nonnegative(),
}).strict());
export type PluginCollectionUiQueryResultV1 = z.infer<typeof PluginCollectionUiQueryResultV1Schema>;

/** Typed terminal outcomes for the one authenticated static UI-query operation. */
export const PluginCollectionUiQueryErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'collection_query_invalid',
  'collection_cursor_invalid',
  'collection_unavailable',
  'collection_index_not_ready',
  'collection_content_mode_mismatch',
  'collection_contract_inconsistent',
]));
export type PluginCollectionUiQueryErrorCodeV1 = z.infer<typeof PluginCollectionUiQueryErrorCodeV1Schema>;

export const PluginCollectionUiQueryErrorV1Schema = lazyZodSchema(() => z.object({
  error: PluginCollectionUiQueryErrorCodeV1Schema,
}).strict());
export type PluginCollectionUiQueryErrorV1 = z.infer<typeof PluginCollectionUiQueryErrorV1Schema>;
