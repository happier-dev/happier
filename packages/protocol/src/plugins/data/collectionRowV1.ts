import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import type { PluginJsonValueV2 } from '../contributions/publicTypes.js';
import { assertStrictPluginJsonValue, measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '../contributions/strictJsonValue.js';
import { PluginCollectionMemberNameV1Schema, PluginCollectionProjectedScalarValueV1Schema } from './collectionContributionV1.js';
import { PluginCollectionRowIdV1Schema } from './collectionUiQueryWireV1.js';
import { PLUGIN_COLLECTION_LIMITS_V1, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1, PLUGIN_COLLECTION_REVISION_MAX } from './collectionLimitsV1.js';

/** Native row and refusal wire schemas; this leaf does not load host crypto or the plugin manifest registry. */
/**
 * `JSON.stringify` abandons its iterative fast path once the serialization
 * grows past a threshold and finishes recursively, so measuring a large,
 * deeply nested — but perfectly valid and in-budget — Collection payload that
 * way throws `RangeError`. Protocol's serialized-byte owner walks with an
 * explicit stack and produces the same spelling, so the ceilings below refuse
 * or admit on bytes rather than on the shape of the host's serializer.
 */
export function measurePluginCollectionValueEncodedBytesV1(value: unknown): number {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('Collection values must be JSON serializable.');
  }
  return measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'Collection value');
}


/**
 * Member values are admitted by Protocol's strict-JSON owner, which walks with
 * an explicit work stack. The declaration-facing `PluginJsonValueV2Schema`
 * describes the same grammar but descends recursively, so a payload nested
 * deeper than the JavaScript call stack throws `RangeError` there instead of
 * being admitted or refused on its merits — and a Collection payload can be
 * that deep while staying far inside the encoded envelope ceiling below.
 *
 * The admitted value is the caller's own already-validated data rather than a
 * copy: this boundary hands the payload straight to sealing or to the request
 * it was built for, and the strict walker reads own data descriptors only, so
 * nothing observes the value between the check and its use.
 */
const PluginCollectionMemberValueV1Schema = lazyZodSchema(() => z.pipe(z.unknown(), z.transform((value, context): PluginJsonValueV2 => {
    try {
      assertStrictPluginJsonValue(value, 'Collection member value');
      return value as PluginJsonValueV2;
    } catch (error) {
      context.issues.push({
        code: "custom",
        message: error instanceof Error ? error.message : 'Invalid Collection member value', input: context.value });
      return z.NEVER;
    }
  })));

export const PluginCollectionPrivatePayloadV1Schema = lazyZodSchema(() => z.record(
  PluginCollectionMemberNameV1Schema,
  PluginCollectionMemberValueV1Schema,
));
export type PluginCollectionPrivatePayloadV1 = z.infer<typeof PluginCollectionPrivatePayloadV1Schema>;


export const PluginCollectionContentEnvelopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: PluginCollectionPrivatePayloadV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), k: z.optional(z.literal('collection')), c: z.string().check(z.minLength(1)) }),
]).check(z.superRefine((value, context) => {
  const encodedBytes = measurePluginCollectionValueEncodedBytesV1(value);
  const effectiveMaximum = PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes;
  if (encodedBytes > effectiveMaximum) {
    context.addIssue({
      code: "custom",
      message: 'Collection private envelope exceeds the 512 KiB encoded limit.',
      params: { reason: 'private-payload-too-large', encodedBytes, effectiveMaximum },
    });
  }
})));
export type PluginCollectionContentEnvelopeV1 = z.infer<typeof PluginCollectionContentEnvelopeV1Schema>;


/** Only declared server-readable scalar fields cross the mutation boundary. */
export const PluginCollectionProjectionV1Schema = lazyZodSchema(() => z.record(
  PluginCollectionMemberNameV1Schema,
  PluginCollectionProjectedScalarValueV1Schema,
).check(z.superRefine((value, context) => {
  if (Object.keys(value).length > 16) {
    context.addIssue({ code: "custom", message: 'A collection projection has too many fields.' });
  }
  if (measurePluginCollectionValueEncodedBytesV1(value) > PLUGIN_COLLECTION_LIMITS_V1.maximumProjectionEncodedBytes) {
    context.addIssue({
      code: "custom",
      message: 'Collection projection exceeds the 64 KiB encoded limit.',
    });
  }
})));
export type PluginCollectionProjectionV1 = z.infer<typeof PluginCollectionProjectionV1Schema>;

/**
 * One exact row currentness witness. Its ceiling is the persisted `Int` column,
 * not a policy number: see `PLUGIN_COLLECTION_REVISION_MAX`.
 */
export const PluginCollectionRevisionV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.positive(), z.maximum(PLUGIN_COLLECTION_REVISION_MAX)));

export const PluginCollectionMutationErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'collection_mutation_invalid',
  'collection_unavailable',
  'collection_writer_contract_unavailable',
  'collection_index_not_ready',
  'collection_relation_unavailable',
  'collection_relation_restricted',
  'collection_content_mode_mismatch',
  'collection_quota_exceeded',
  'collection_quota_incompatible',
  'collection_contract_inconsistent',
  'collection_revision_exhausted',
]));
export type PluginCollectionMutationErrorCodeV1 = z.infer<typeof PluginCollectionMutationErrorCodeV1Schema>;

/**
 * The named effective limit that made a current Collection state incompatible.
 * These names are shared by mutation and Availability readiness failures.
 */
export const PluginCollectionQuotaDimensionV1Schema = lazyZodSchema(() => z.enum([
  'maxRowEncodedBytes',
  'maxRows',
  'maxCollectionEncodedBytes',
  'maxBatchRows',
  'maxBatchBytes',
  'maxAccountRows',
  'maxAccountBytes',
]));
export type PluginCollectionQuotaDimensionV1 = z.infer<typeof PluginCollectionQuotaDimensionV1Schema>;

export const PluginCollectionQuotaIncompatibleErrorV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal('collection_quota_incompatible'),
  dimension: PluginCollectionQuotaDimensionV1Schema,
  effectiveMaximum: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
export type PluginCollectionQuotaIncompatibleErrorV1 = z.infer<
  typeof PluginCollectionQuotaIncompatibleErrorV1Schema
>;

/**
 * A restricted relation carries one fully specified page over its existing
 * source Collection index. Callers reuse the ordinary Collection query and
 * cursor; this schema does not introduce another paging protocol.
 */
export const PluginCollectionRelationRestrictionQueryV1Schema = lazyZodSchema(() => z.strictObject({
  indexId: PluginCollectionMemberNameV1Schema,
  prefix: z.array(PluginCollectionRowIdV1Schema).check(z.length(1)),
  order: z.literal('asc'),
  limit: z.number().check(z.int(), z.minimum(1), z.maximum(PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1)),
}));
export type PluginCollectionRelationRestrictionQueryV1 = z.infer<
  typeof PluginCollectionRelationRestrictionQueryV1Schema
>;

export const PluginCollectionRelationRestrictionContinuationV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  relationId: PluginCollectionMemberNameV1Schema,
  target: z.strictObject({
    collectionId: asProtocolZod(PluginContributionLocalIdSchema),
    rowId: PluginCollectionRowIdV1Schema,
  }),
  query: PluginCollectionRelationRestrictionQueryV1Schema,
}));
export type PluginCollectionRelationRestrictionContinuationV1 = z.infer<
  typeof PluginCollectionRelationRestrictionContinuationV1Schema
>;

const PluginCollectionSimpleMutationErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'collection_mutation_invalid',
  'collection_unavailable',
  'collection_writer_contract_unavailable',
  'collection_index_not_ready',
  'collection_relation_unavailable',
  'collection_content_mode_mismatch',
  'collection_quota_exceeded',
  'collection_contract_inconsistent',
  'collection_revision_exhausted',
]));

export const PluginCollectionMutationErrorV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    error: PluginCollectionSimpleMutationErrorCodeV1Schema,
  }),
  PluginCollectionQuotaIncompatibleErrorV1Schema,
  z.strictObject({
    error: z.literal('collection_relation_restricted'),
    dependentCount: z.number().check(z.int(), z.minimum(1), z.maximum(PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1)),
    continuation: PluginCollectionRelationRestrictionContinuationV1Schema,
  }),
]));
export type PluginCollectionMutationErrorV1 = z.infer<typeof PluginCollectionMutationErrorV1Schema>;

/** One decoded collection row at the direct authenticated Data boundary. */
export const PluginCollectionRowV1Schema = lazyZodSchema(() => z.strictObject({
  rowId: PluginCollectionRowIdV1Schema,
  revision: PluginCollectionRevisionV1Schema,
  content: PluginCollectionContentEnvelopeV1Schema,
  projection: PluginCollectionProjectionV1Schema,
  /** Present only for promoted resource-key rows; never grants access. */
  encryptedDataKey: z.optional(z.nullable(z.string())),
}));
export type PluginCollectionRowV1 = z.infer<typeof PluginCollectionRowV1Schema>;
