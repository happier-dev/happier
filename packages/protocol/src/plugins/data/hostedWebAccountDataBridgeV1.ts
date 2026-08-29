import { z } from 'zod';

import {
  PluginCollectionOpaqueCursorV1Schema,
  PluginCollectionRowIdV1Schema,
  PluginCollectionUiQueryErrorV1Schema,
  PluginCollectionUiQueryRequestV1Schema,
  PluginCollectionUiRowV1Schema,
} from './collectionUiQueryWireV1.js';
import {
  PluginAccountCollectionContributionV1Schema,
  PluginCollectionFiniteNumberV1Schema,
  PluginCollectionMemberNameV1Schema,
} from './collectionContributionV1.js';
import {
  PluginAccountStorageJsonValueV1Schema,
  PluginAccountStorageLogicalKeyV1Schema,
} from './accountKvValueV1.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/**
 * The one Data-owned operation arm carried through an authenticated hosted-web
 * bridge. This name is intentionally about the complete mounted Account Data
 * client, not just the static Collection query subset.
 */
export const PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1 = 'accountData' as const;

export const OpaqueHostedWebAccountDataQueryIdV1Schema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

const PluginHostedWebAccountDataDefinitionV1Schema = PluginAccountCollectionContributionV1Schema;

const AccountDataExpectedRevisionV1Schema = z.union([z.number().int().nonnegative(), z.literal('absent')]);
const AccountDataExpectedVersionV1Schema = z.union([z.number().int().nonnegative(), z.literal('absent')]);
const AccountDataCollectionValueV1Schema = z.record(
  PluginCollectionMemberNameV1Schema,
  PluginUiJsonValueV1Schema,
).superRefine((value, context) => {
  if (Object.keys(value).length === 0) context.addIssue({ code: 'custom', message: 'Collection values must contain at least one field.' });
});
const AccountDataCollectionScalarV1Schema = z.union([
  z.null(),
  z.boolean(),
  z.string(),
  PluginCollectionFiniteNumberV1Schema,
]);
const AccountDataCollectionQueryV1Schema = z.object({
  index: PluginCollectionMemberNameV1Schema,
  prefix: z.array(AccountDataCollectionScalarV1Schema).max(4).default([]),
  range: z.object({
    lower: AccountDataCollectionScalarV1Schema.optional(),
    upper: AccountDataCollectionScalarV1Schema.optional(),
  }).strict().optional(),
  order: z.enum(['asc', 'desc']),
  cursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
const AccountDataCollectionMutationV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('put'),
    value: AccountDataCollectionValueV1Schema,
    expectedRevision: AccountDataExpectedRevisionV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('delete'),
    rowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('assert'),
    rowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
  }).strict(),
]);
const AccountDataCollectionMutationListV1Schema = z.array(AccountDataCollectionMutationV1Schema).min(1).max(100);
const AccountDataExpectedRevisionOptionsV1Schema = z.object({ expectedRevision: AccountDataExpectedRevisionV1Schema }).strict();
const AccountDataExpectedVersionOptionsV1Schema = z.object({ expectedVersion: AccountDataExpectedVersionV1Schema }).strict();
const AccountDataExpectedDeleteVersionOptionsV1Schema = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();
const AccountDataListOptionsV1Schema = z.object({ cursor: z.string().min(1).optional(), limit: z.number().int().min(1).max(1000).optional(), prefix: z.string().optional() }).strict();
const AccountDataIdentityTagV1Schema = z.object({ field: PluginCollectionMemberNameV1Schema, components: z.array(z.string()).min(1).max(16) }).strict();

const PluginHostedWebAccountDataCollectionOperationV1Schema = z.discriminatedUnion('operation', [
  z.object({
    kind: z.literal('data'),
    operation: z.literal('collection.identityTag'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([AccountDataIdentityTagV1Schema]),
  }).strict(),
  z.object({
    kind: z.literal('data'),
    operation: z.literal('collection.get'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([PluginCollectionRowIdV1Schema]),
  }).strict(),
  z.object({
    kind: z.literal('data'),
    operation: z.literal('collection.put'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([AccountDataCollectionValueV1Schema, AccountDataExpectedRevisionOptionsV1Schema]),
  }).strict(),
  z.object({
    kind: z.literal('data'),
    operation: z.literal('collection.delete'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([PluginCollectionRowIdV1Schema, z.object({ expectedRevision: z.number().int().positive() }).strict()]),
  }).strict(),
  z.object({
    kind: z.literal('data'),
    operation: z.literal('collection.query'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([AccountDataCollectionQueryV1Schema]),
  }).strict(),
  z.object({
    kind: z.literal('data'),
    operation: z.literal('collection.batch'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([AccountDataCollectionMutationListV1Schema]),
  }).strict(),
  z.object({
    kind: z.literal('data'),
    operation: z.literal('collection.limits'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([]),
  }).strict(),
  z.object({
    kind: z.literal('data'),
    operation: z.literal('collection.measureBatch'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([AccountDataCollectionMutationListV1Schema]),
  }).strict(),
]);

const PluginHostedWebAccountDataStorageOperationV1Schema = z.discriminatedUnion('operation', [
  z.object({ kind: z.literal('data'), operation: z.literal('accountKv.get'), arguments: z.tuple([PluginAccountStorageLogicalKeyV1Schema]) }).strict(),
  z.object({ kind: z.literal('data'), operation: z.literal('accountKv.set'), arguments: z.tuple([PluginAccountStorageLogicalKeyV1Schema, PluginAccountStorageJsonValueV1Schema, AccountDataExpectedVersionOptionsV1Schema]) }).strict(),
  z.object({ kind: z.literal('data'), operation: z.literal('accountKv.delete'), arguments: z.tuple([PluginAccountStorageLogicalKeyV1Schema, AccountDataExpectedDeleteVersionOptionsV1Schema]) }).strict(),
  z.object({ kind: z.literal('data'), operation: z.literal('accountKv.list'), arguments: z.tuple([AccountDataListOptionsV1Schema]) }).strict(),
  z.object({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.begin'), arguments: z.tuple([]) }).strict(),
  z.object({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.get'), arguments: z.tuple([z.string().min(1), PluginAccountStorageLogicalKeyV1Schema]) }).strict(),
  z.object({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.set'), arguments: z.tuple([z.string().min(1), PluginAccountStorageLogicalKeyV1Schema, z.object({ value: PluginAccountStorageJsonValueV1Schema, expectedVersion: AccountDataExpectedVersionV1Schema }).strict()]) }).strict(),
  z.object({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.delete'), arguments: z.tuple([z.string().min(1), PluginAccountStorageLogicalKeyV1Schema, AccountDataExpectedDeleteVersionOptionsV1Schema]) }).strict(),
  z.object({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.commit'), arguments: z.tuple([z.string().min(1)]) }).strict(),
  z.object({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.rollback'), arguments: z.tuple([z.string().min(1)]) }).strict(),
]);

/**
 * The complete Account Data operation grammar. Each method has one named,
 * strict tuple schema, so scalar and option values are checked before either
 * realm adapter can cast them into a direct Data service call. Collection
 * definitions remain present only on Collection arms; Account KV and Settings
 * cannot smuggle a definition across their ownership boundary.
 */
const PluginHostedWebAccountDataOperationV1Schema = z.union([
  PluginHostedWebAccountDataCollectionOperationV1Schema,
  PluginHostedWebAccountDataStorageOperationV1Schema,
]);

export const PluginHostedWebAccountDataBridgeOperationV1Schema = z.union([
  PluginCollectionUiQueryRequestV1Schema.pick({
    collectionId: true,
    uiQueryId: true,
    parameters: true,
  }).extend({ kind: z.literal('open') }).strict(),
  z.object({
    kind: z.literal('page'),
    queryId: OpaqueHostedWebAccountDataQueryIdV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('close'),
    queryId: OpaqueHostedWebAccountDataQueryIdV1Schema,
  }).strict(),
  PluginHostedWebAccountDataOperationV1Schema,
]);
export type PluginHostedWebAccountDataBridgeOperationV1 = z.infer<
  typeof PluginHostedWebAccountDataBridgeOperationV1Schema
>;

/**
 * Outer request control is separate from Data operation semantics. The bridge
 * transport owns the outer sequence and therefore owns cancellation; no guest
 * request id becomes a second correlation authority.
 */
export const PluginHostedWebAccountDataBridgeRequestV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request'),
    operation: PluginHostedWebAccountDataBridgeOperationV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('cancel'),
    requestSequence: z.number().int().nonnegative(),
  }).strict(),
]);
export type PluginHostedWebAccountDataBridgeRequestV1 = z.infer<
  typeof PluginHostedWebAccountDataBridgeRequestV1Schema
>;

const PluginHostedWebAccountDataBridgeRowsV1Schema = z.array(
  PluginCollectionUiRowV1Schema,
).max(200);

/**
 * A bounded public pager snapshot. The Data owner never exposes its opaque
 * continuation, Account scope, credentials, contract ref, or raw envelope.
 */
export const PluginHostedWebAccountDataBridgeSnapshotV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('idle'),
    rows: PluginHostedWebAccountDataBridgeRowsV1Schema,
    hasMore: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('loading'),
    rows: PluginHostedWebAccountDataBridgeRowsV1Schema,
    hasMore: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('ready'),
    rows: PluginHostedWebAccountDataBridgeRowsV1Schema,
    hasMore: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    rows: PluginHostedWebAccountDataBridgeRowsV1Schema.length(0),
    hasMore: z.literal(false),
  }).strict(),
  z.object({
    status: z.literal('error'),
    rows: PluginHostedWebAccountDataBridgeRowsV1Schema,
    hasMore: z.boolean(),
    error: PluginCollectionUiQueryErrorV1Schema.optional(),
  }).strict(),
]);
export type PluginHostedWebAccountDataBridgeSnapshotV1 = z.infer<
  typeof PluginHostedWebAccountDataBridgeSnapshotV1Schema
>;

/** Responses remain on the bridge's existing request-sequence correlation path. */
export const PluginHostedWebAccountDataBridgeResponseV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('snapshot'),
    queryId: OpaqueHostedWebAccountDataQueryIdV1Schema,
    snapshot: PluginHostedWebAccountDataBridgeSnapshotV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('closed'),
    queryId: OpaqueHostedWebAccountDataQueryIdV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('data'),
    value: PluginUiJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('error'),
    error: z.object({
      code: z.string().min(1),
      message: z.string().optional(),
      retryable: z.boolean().optional(),
      details: PluginUiJsonValueV1Schema.optional(),
    }).strict(),
  }).strict(),
]);
export type PluginHostedWebAccountDataBridgeResponseV1 = z.infer<
  typeof PluginHostedWebAccountDataBridgeResponseV1Schema
>;

/**
 * AccountChange reaches the Data pager as a content-free invalidation. The
 * bridge preserves that boundary: a guest receives only its opaque query
 * correlation and reopens through the Data-owned static query operation.
 */
export const PluginHostedWebAccountDataBridgeChangeV1Schema = z.object({
  kind: z.literal('change'),
  queryId: OpaqueHostedWebAccountDataQueryIdV1Schema,
}).strict();
export type PluginHostedWebAccountDataBridgeChangeV1 = z.infer<
  typeof PluginHostedWebAccountDataBridgeChangeV1Schema
>;
