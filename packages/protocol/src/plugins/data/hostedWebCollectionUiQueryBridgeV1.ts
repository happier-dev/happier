import { z } from 'zod';

import {
  PluginCollectionUiQueryErrorV1Schema,
  PluginCollectionUiQueryRequestV1Schema,
  PluginCollectionUiRowV1Schema,
} from './collectionUiQueryWireV1.js';

/**
 * The one Data-owned operation arm carried through an authenticated hosted-web
 * bridge. It is intentionally not a host-API method or a generic RPC channel.
 */
export const PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1 = 'collectionUiQuery' as const;

const OpaqueHostedWebCollectionUiQueryIdV1Schema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

/**
 * Guest-visible operations contain only a declared static query selector and
 * its bounded logical parameters. The mounted Data adapter stamps plugin,
 * Account, release contract and private cursor state.
 */
export const PluginHostedWebCollectionUiQueryBridgeOperationV1Schema = z.discriminatedUnion('kind', [
  PluginCollectionUiQueryRequestV1Schema.pick({
    collectionId: true,
    uiQueryId: true,
    parameters: true,
  }).extend({ kind: z.literal('open') }).strict(),
  z.object({
    kind: z.literal('page'),
    queryId: OpaqueHostedWebCollectionUiQueryIdV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('close'),
    queryId: OpaqueHostedWebCollectionUiQueryIdV1Schema,
  }).strict(),
]);
export type PluginHostedWebCollectionUiQueryBridgeOperationV1 = z.infer<
  typeof PluginHostedWebCollectionUiQueryBridgeOperationV1Schema
>;

/**
 * Outer request control is separate from Data operation semantics. The bridge
 * transport owns the outer sequence and therefore owns cancellation; no guest
 * request id becomes a second correlation authority.
 */
export const PluginHostedWebCollectionUiQueryBridgeRequestV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request'),
    operation: PluginHostedWebCollectionUiQueryBridgeOperationV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('cancel'),
    requestSequence: z.number().int().nonnegative(),
  }).strict(),
]);
export type PluginHostedWebCollectionUiQueryBridgeRequestV1 = z.infer<
  typeof PluginHostedWebCollectionUiQueryBridgeRequestV1Schema
>;

const PluginHostedWebCollectionUiQueryBridgeRowsV1Schema = z.array(
  PluginCollectionUiRowV1Schema,
).max(200);

/**
 * A bounded public pager snapshot. The Data owner never exposes its opaque
 * continuation, Account scope, credentials, contract ref, or raw envelope.
 */
export const PluginHostedWebCollectionUiQueryBridgeSnapshotV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('idle'),
    rows: PluginHostedWebCollectionUiQueryBridgeRowsV1Schema,
    hasMore: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('loading'),
    rows: PluginHostedWebCollectionUiQueryBridgeRowsV1Schema,
    hasMore: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('ready'),
    rows: PluginHostedWebCollectionUiQueryBridgeRowsV1Schema,
    hasMore: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    rows: PluginHostedWebCollectionUiQueryBridgeRowsV1Schema.length(0),
    hasMore: z.literal(false),
  }).strict(),
  z.object({
    status: z.literal('error'),
    rows: PluginHostedWebCollectionUiQueryBridgeRowsV1Schema,
    hasMore: z.boolean(),
    error: PluginCollectionUiQueryErrorV1Schema.optional(),
  }).strict(),
]);
export type PluginHostedWebCollectionUiQueryBridgeSnapshotV1 = z.infer<
  typeof PluginHostedWebCollectionUiQueryBridgeSnapshotV1Schema
>;

/** Responses remain on the bridge's existing request-sequence correlation path. */
export const PluginHostedWebCollectionUiQueryBridgeResponseV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('snapshot'),
    queryId: OpaqueHostedWebCollectionUiQueryIdV1Schema,
    snapshot: PluginHostedWebCollectionUiQueryBridgeSnapshotV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('closed'),
    queryId: OpaqueHostedWebCollectionUiQueryIdV1Schema,
  }).strict(),
]);
export type PluginHostedWebCollectionUiQueryBridgeResponseV1 = z.infer<
  typeof PluginHostedWebCollectionUiQueryBridgeResponseV1Schema
>;

/**
 * AccountChange reaches the Data pager as a content-free invalidation. The
 * bridge preserves that boundary: a guest receives only its opaque query
 * correlation and reopens through the Data-owned static query operation.
 */
export const PluginHostedWebCollectionUiQueryBridgeChangeV1Schema = z.object({
  kind: z.literal('change'),
  queryId: OpaqueHostedWebCollectionUiQueryIdV1Schema,
}).strict();
export type PluginHostedWebCollectionUiQueryBridgeChangeV1 = z.infer<
  typeof PluginHostedWebCollectionUiQueryBridgeChangeV1Schema
>;
