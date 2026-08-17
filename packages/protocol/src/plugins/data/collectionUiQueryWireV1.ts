import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  PluginCollectionFiniteNumberV1Schema,
  PluginCollectionMemberNameV1Schema,
  PluginCollectionProjectedScalarValueV1Schema,
} from './collectionContributionV1.js';

const MAX_COLLECTION_ROW_ID_UTF8_BYTES = 256;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** A stable Data row identity shared by direct and UI-query wire contracts. */
export const PluginCollectionRowIdV1Schema = z.string().min(1).superRefine((value, context) => {
  if (value.includes('\u0000')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Row ID must not contain NUL.' });
  }
  if (utf8ByteLength(value) > MAX_COLLECTION_ROW_ID_UTF8_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Row ID exceeds the 256-byte limit.' });
  }
});
export type PluginCollectionRowIdV1 = z.infer<typeof PluginCollectionRowIdV1Schema>;

/** Opaque direct and UI-query continuation evidence; callers cannot interpret it. */
export const PluginCollectionOpaqueCursorV1Schema = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/);

/**
 * The authenticated static UI-query request and result wire are realm-neutral:
 * Account qualification, contract admission, and private cursor ownership stay
 * with the direct Data client that consumes them.
 */
export const PluginCollectionUiQueryRequestV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  uiQueryId: PluginCollectionMemberNameV1Schema,
  parameters: z.record(
    PluginCollectionMemberNameV1Schema,
    z.union([z.string(), PluginCollectionFiniteNumberV1Schema, z.boolean()]),
  ).default({}),
  cursor: PluginCollectionOpaqueCursorV1Schema.optional(),
}).strict();
export type PluginCollectionUiQueryRequestV1 = z.infer<typeof PluginCollectionUiQueryRequestV1Schema>;

export const PluginCollectionUiRowContextV1Schema = z.object({
  collection: z.object({
    pluginId: asProtocolZod(PluginIdSchema),
    collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
  rowId: PluginCollectionRowIdV1Schema,
  revision: z.number().int().positive(),
}).strict();
export type PluginCollectionUiRowContextV1 = z.infer<typeof PluginCollectionUiRowContextV1Schema>;

const PluginCollectionUiRowFieldsV1Schema = z.record(
  PluginCollectionMemberNameV1Schema,
  PluginCollectionProjectedScalarValueV1Schema,
).superRefine((value, context) => {
  if (Object.keys(value).length > 16) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A UI query row has too many projected fields.' });
  }
});

export const PluginCollectionUiRowV1Schema = z.object({
  context: PluginCollectionUiRowContextV1Schema,
  fields: PluginCollectionUiRowFieldsV1Schema,
}).strict();
export type PluginCollectionUiRowV1 = z.infer<typeof PluginCollectionUiRowV1Schema>;

export const PluginCollectionUiQueryResultV1Schema = z.object({
  rows: z.array(PluginCollectionUiRowV1Schema).max(200),
  nextCursor: PluginCollectionOpaqueCursorV1Schema.optional(),
  changeCursor: z.number().int().nonnegative(),
}).strict();
export type PluginCollectionUiQueryResultV1 = z.infer<typeof PluginCollectionUiQueryResultV1Schema>;

/** Typed terminal outcomes for the one authenticated static UI-query operation. */
export const PluginCollectionUiQueryErrorCodeV1Schema = z.enum([
  'collection_query_invalid',
  'collection_cursor_invalid',
  'collection_unavailable',
  'collection_index_not_ready',
  'collection_content_mode_mismatch',
  'collection_contract_inconsistent',
]);
export type PluginCollectionUiQueryErrorCodeV1 = z.infer<typeof PluginCollectionUiQueryErrorCodeV1Schema>;

export const PluginCollectionUiQueryErrorV1Schema = z.object({
  error: PluginCollectionUiQueryErrorCodeV1Schema,
}).strict();
export type PluginCollectionUiQueryErrorV1 = z.infer<typeof PluginCollectionUiQueryErrorV1Schema>;
