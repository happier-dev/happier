import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

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

export { PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1 } from './hostedWebAccountDataBridgeKindV1.js';

export const OpaqueHostedWebAccountDataQueryIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(128), z.regex(/^[A-Za-z0-9_-]+$/u)));

const PluginHostedWebAccountDataDefinitionV1Schema = PluginAccountCollectionContributionV1Schema;

const AccountDataExpectedRevisionV1Schema = lazyZodSchema(() => z.union([z.number().check(z.int(), z.nonnegative()), z.literal('absent')]));
const AccountDataExpectedVersionV1Schema = lazyZodSchema(() => z.union([z.number().check(z.int(), z.nonnegative()), z.literal('absent')]));
const AccountDataCollectionValueV1Schema = lazyZodSchema(() => z.record(
  PluginCollectionMemberNameV1Schema,
  PluginUiJsonValueV1Schema,
).check(z.superRefine((value, context) => {
  if (Object.keys(value).length === 0) context.addIssue({ code: 'custom', message: 'Collection values must contain at least one field.' });
})));
const AccountDataCollectionScalarV1Schema = lazyZodSchema(() => z.union([
  z.null(),
  z.boolean(),
  z.string(),
  PluginCollectionFiniteNumberV1Schema,
]));
const AccountDataCollectionQueryV1Schema = lazyZodSchema(() => z.strictObject({
  index: PluginCollectionMemberNameV1Schema,
  prefix: z._default(z.array(AccountDataCollectionScalarV1Schema).check(z.maxLength(4)), []),
  range: z.optional(z.strictObject({
    lower: z.optional(AccountDataCollectionScalarV1Schema),
    upper: z.optional(AccountDataCollectionScalarV1Schema),
  })),
  order: z.enum(['asc', 'desc']),
  cursor: zMini.optional(asProtocolZod(PluginCollectionOpaqueCursorV1Schema)),
  limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(200)), 50),
}));
const AccountDataCollectionMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('put'),
    value: AccountDataCollectionValueV1Schema,
    expectedRevision: AccountDataExpectedRevisionV1Schema,
  }),
  z.strictObject({
    kind: z.literal('delete'),
    rowId: z.string().check(z.minLength(1)),
    expectedRevision: z.number().check(z.int(), z.positive()),
  }),
  z.strictObject({
    kind: z.literal('assert'),
    rowId: z.string().check(z.minLength(1)),
    expectedRevision: z.number().check(z.int(), z.positive()),
  }),
]));
const AccountDataCollectionMutationListV1Schema = lazyZodSchema(() => z.array(AccountDataCollectionMutationV1Schema).check(z.minLength(1), z.maxLength(100)));
const AccountDataExpectedRevisionOptionsV1Schema = lazyZodSchema(() => z.strictObject({ expectedRevision: AccountDataExpectedRevisionV1Schema }));
const AccountDataExpectedVersionOptionsV1Schema = lazyZodSchema(() => z.strictObject({ expectedVersion: AccountDataExpectedVersionV1Schema }));
const AccountDataExpectedDeleteVersionOptionsV1Schema = lazyZodSchema(() => z.strictObject({ expectedVersion: z.number().check(z.int(), z.nonnegative()) }));
const AccountDataListOptionsV1Schema = lazyZodSchema(() => z.strictObject({ cursor: z.optional(z.string().check(z.minLength(1))), limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1000))), prefix: z.optional(z.string()) }));
const AccountDataIdentityTagV1Schema = lazyZodSchema(() => z.strictObject({ field: PluginCollectionMemberNameV1Schema, components: z.array(z.string()).check(z.minLength(1), z.maxLength(16)) }));

const PluginHostedWebAccountDataCollectionOperationV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.strictObject({
    kind: z.literal('data'),
    operation: z.literal('collection.identityTag'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([AccountDataIdentityTagV1Schema]),
  }),
  z.strictObject({
    kind: z.literal('data'),
    operation: z.literal('collection.get'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([PluginCollectionRowIdV1Schema]),
  }),
  z.strictObject({
    kind: z.literal('data'),
    operation: z.literal('collection.put'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([AccountDataCollectionValueV1Schema, AccountDataExpectedRevisionOptionsV1Schema]),
  }),
  z.strictObject({
    kind: z.literal('data'),
    operation: z.literal('collection.delete'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([PluginCollectionRowIdV1Schema, z.strictObject({ expectedRevision: z.number().check(z.int(), z.positive()) })]),
  }),
  z.strictObject({
    kind: z.literal('data'),
    operation: z.literal('collection.forget'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([PluginCollectionRowIdV1Schema, z.strictObject({ expectedRevision: z.number().check(z.int(), z.positive()) })]),
  }),
  z.strictObject({
    kind: z.literal('data'),
    operation: z.literal('collection.query'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([AccountDataCollectionQueryV1Schema]),
  }),
  z.strictObject({
    kind: z.literal('data'),
    operation: z.literal('collection.batch'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([AccountDataCollectionMutationListV1Schema]),
  }),
  z.strictObject({
    kind: z.literal('data'),
    operation: z.literal('collection.limits'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([]),
  }),
  z.strictObject({
    kind: z.literal('data'),
    operation: z.literal('collection.measureBatch'),
    definition: PluginHostedWebAccountDataDefinitionV1Schema,
    arguments: z.tuple([AccountDataCollectionMutationListV1Schema]),
  }),
]));

const PluginHostedWebAccountDataStorageOperationV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.strictObject({ kind: z.literal('data'), operation: z.literal('accountKv.get'), arguments: z.tuple([PluginAccountStorageLogicalKeyV1Schema]) }),
  z.strictObject({ kind: z.literal('data'), operation: z.literal('accountKv.set'), arguments: z.tuple([PluginAccountStorageLogicalKeyV1Schema, PluginAccountStorageJsonValueV1Schema, AccountDataExpectedVersionOptionsV1Schema]) }),
  z.strictObject({ kind: z.literal('data'), operation: z.literal('accountKv.delete'), arguments: z.tuple([PluginAccountStorageLogicalKeyV1Schema, AccountDataExpectedDeleteVersionOptionsV1Schema]) }),
  z.strictObject({ kind: z.literal('data'), operation: z.literal('accountKv.list'), arguments: z.tuple([AccountDataListOptionsV1Schema]) }),
  z.strictObject({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.begin'), arguments: z.tuple([]) }),
  z.strictObject({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.get'), arguments: z.tuple([z.string().check(z.minLength(1)), PluginAccountStorageLogicalKeyV1Schema]) }),
  z.strictObject({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.set'), arguments: z.tuple([z.string().check(z.minLength(1)), PluginAccountStorageLogicalKeyV1Schema, z.strictObject({ value: PluginAccountStorageJsonValueV1Schema, expectedVersion: AccountDataExpectedVersionV1Schema })]) }),
  z.strictObject({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.delete'), arguments: z.tuple([z.string().check(z.minLength(1)), PluginAccountStorageLogicalKeyV1Schema, AccountDataExpectedDeleteVersionOptionsV1Schema]) }),
  z.strictObject({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.commit'), arguments: z.tuple([z.string().check(z.minLength(1))]) }),
  z.strictObject({ kind: z.literal('data'), operation: z.literal('accountKv.transaction.rollback'), arguments: z.tuple([z.string().check(z.minLength(1))]) }),
]));

/**
 * The complete Account Data operation grammar. Each method has one named,
 * strict tuple schema, so scalar and option values are checked before either
 * realm adapter can cast them into a direct Data service call. Collection
 * definitions remain present only on Collection arms; Account KV and Settings
 * cannot smuggle a definition across their ownership boundary.
 */
const PluginHostedWebAccountDataOperationV1Schema = lazyZodSchema(() => z.union([
  PluginHostedWebAccountDataCollectionOperationV1Schema,
  PluginHostedWebAccountDataStorageOperationV1Schema,
]));

export const PluginHostedWebAccountDataBridgeOperationV1Schema = lazyZodSchema(() => z.union([
  (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(zMini.pick(PluginCollectionUiQueryRequestV1Schema, {
    collectionId: true,
    uiQueryId: true,
    parameters: true,
  }), { kind: z.literal('open') })),
  z.strictObject({
    kind: z.literal('page'),
    queryId: OpaqueHostedWebAccountDataQueryIdV1Schema,
  }),
  z.strictObject({
    kind: z.literal('close'),
    queryId: OpaqueHostedWebAccountDataQueryIdV1Schema,
  }),
  PluginHostedWebAccountDataOperationV1Schema,
]));
export type PluginHostedWebAccountDataBridgeOperationV1 = z.infer<
  typeof PluginHostedWebAccountDataBridgeOperationV1Schema
>;

/**
 * Outer request control is separate from Data operation semantics. The bridge
 * transport owns the outer sequence and therefore owns cancellation; no guest
 * request id becomes a second correlation authority.
 */
export const PluginHostedWebAccountDataBridgeRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('request'),
    operation: PluginHostedWebAccountDataBridgeOperationV1Schema,
  }),
  z.strictObject({
    kind: z.literal('cancel'),
    requestSequence: z.number().check(z.int(), z.nonnegative()),
  }),
]));
export type PluginHostedWebAccountDataBridgeRequestV1 = z.infer<
  typeof PluginHostedWebAccountDataBridgeRequestV1Schema
>;

const PluginHostedWebAccountDataBridgeRowsV1Schema = lazyZodSchema(() => z.array(
  PluginCollectionUiRowV1Schema,
).check(z.maxLength(200)));

/**
 * A bounded public pager snapshot. The Data owner never exposes its opaque
 * continuation, Account scope, credentials, contract ref, or raw envelope.
 */
export const PluginHostedWebAccountDataBridgeSnapshotV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('idle'),
    rows: PluginHostedWebAccountDataBridgeRowsV1Schema,
    hasMore: z.boolean(),
  }),
  z.strictObject({
    status: z.literal('loading'),
    rows: PluginHostedWebAccountDataBridgeRowsV1Schema,
    hasMore: z.boolean(),
  }),
  z.strictObject({
    status: z.literal('ready'),
    rows: PluginHostedWebAccountDataBridgeRowsV1Schema,
    hasMore: z.boolean(),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    rows: PluginHostedWebAccountDataBridgeRowsV1Schema.check(z.length(0)),
    hasMore: z.literal(false),
  }),
  z.strictObject({
    status: z.literal('error'),
    rows: PluginHostedWebAccountDataBridgeRowsV1Schema,
    hasMore: z.boolean(),
    error: zMini.optional(PluginCollectionUiQueryErrorV1Schema),
  }),
]));
export type PluginHostedWebAccountDataBridgeSnapshotV1 = z.infer<
  typeof PluginHostedWebAccountDataBridgeSnapshotV1Schema
>;

/** Responses remain on the bridge's existing request-sequence correlation path. */
export const PluginHostedWebAccountDataBridgeResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('snapshot'),
    queryId: OpaqueHostedWebAccountDataQueryIdV1Schema,
    snapshot: PluginHostedWebAccountDataBridgeSnapshotV1Schema,
  }),
  z.strictObject({
    kind: z.literal('closed'),
    queryId: OpaqueHostedWebAccountDataQueryIdV1Schema,
  }),
  z.strictObject({
    kind: z.literal('data'),
    value: PluginUiJsonValueV1Schema,
  }),
  z.strictObject({
    kind: z.literal('error'),
    error: z.strictObject({
      code: z.string().check(z.minLength(1)),
      message: z.optional(z.string()),
      retryable: z.optional(z.boolean()),
      details: zMini.optional(PluginUiJsonValueV1Schema),
    }),
  }),
]));
export type PluginHostedWebAccountDataBridgeResponseV1 = z.infer<
  typeof PluginHostedWebAccountDataBridgeResponseV1Schema
>;

/**
 * AccountChange reaches the Data pager as a content-free invalidation. The
 * bridge preserves that boundary: a guest receives only its opaque query
 * correlation and reopens through the Data-owned static query operation.
 */
export const PluginHostedWebAccountDataBridgeChangeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('change'),
  queryId: OpaqueHostedWebAccountDataQueryIdV1Schema,
}));
export type PluginHostedWebAccountDataBridgeChangeV1 = z.infer<
  typeof PluginHostedWebAccountDataBridgeChangeV1Schema
>;
