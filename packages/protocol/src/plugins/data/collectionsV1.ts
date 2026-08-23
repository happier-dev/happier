import { z } from 'zod';

import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import {
  isAccountScopedBlobCiphertextForKind,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../../crypto/accountScopedCipher.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginUiArtifactDigestV1Schema } from '../ui/artifactIntegrity.js';
import {
  PluginJsonSchemaV2Schema,
  type PluginJsonSchemaV2,
  type PluginJsonValueV2,
} from '../contributions/publicTypes.js';
import {
  assertStrictPluginJsonValue,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../contributions/strictJsonValue.js';
import {
  PluginAccountCollectionContributionV1Schema,
  PluginCollectionFiniteNumberV1Schema,
  PluginCollectionIndexPrefixQuotaV1Schema,
  PluginCollectionIndexV1Schema,
  PluginCollectionMigrationDeclarationV1Schema,
  PluginCollectionMemberNameV1Schema,
  PluginCollectionProjectedScalarFieldRefV1Schema,
  PluginCollectionProjectedScalarValueV1Schema,
  PluginCollectionQuotaRequestV1Schema,
  PluginCollectionSchemaV1Schema,
  PluginCollectionSchemaVersionV1Schema,
  PluginCollectionUiQueryParameterV1Schema,
  PluginCollectionUiQueryValueV1Schema,
  PluginCollectionRelationV1Schema,
  type PluginAccountCollectionContributionV1,
  type PluginCollectionIndexV1,
  type PluginCollectionIndexPrefixQuotaV1,
  type PluginCollectionMigrationDeclarationV1,
  type PluginCollectionQuotaRequestV1,
  type PluginCollectionRelationV1,
  type PluginCollectionScalarKindV1,
  type PluginCollectionUiQueryDescriptorV1,
  type PluginCollectionUiQueryParameterV1,
  type PluginCollectionUiQueryValueV1,
} from './collectionContributionV1.js';
import {
  PluginCollectionOpaqueCursorV1Schema,
  PluginCollectionRowIdV1Schema,
  PluginCollectionUiQueryErrorCodeV1Schema,
  PluginCollectionUiQueryErrorV1Schema,
  PluginCollectionUiQueryRequestV1Schema,
  PluginCollectionUiQueryResultV1Schema,
  PluginCollectionUiRowContextV1Schema,
  PluginCollectionUiRowV1Schema,
  type PluginCollectionRowIdV1,
  type PluginCollectionUiQueryErrorCodeV1,
  type PluginCollectionUiQueryErrorV1,
  type PluginCollectionUiQueryRequestV1,
  type PluginCollectionUiQueryResultV1,
  type PluginCollectionUiRowContextV1,
  type PluginCollectionUiRowV1,
} from './collectionUiQueryWireV1.js';
import {
  PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
  PLUGIN_COLLECTION_LIMITS_V1,
} from './collectionLimitsV1.js';
import type {
  PluginDataCollectionsCapabilities,
} from '../../features/payload/capabilities/pluginDataCollectionsCapabilities.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export {
  PluginAccountCollectionContributionV1Schema,
  PluginCollectionIndexFieldV1Schema,
  PluginCollectionIndexPrefixQuotaV1Schema,
  PluginCollectionIndexV1Schema,
  PluginCollectionMigrationDeclarationV1Schema,
  PluginCollectionMemberNameV1Schema,
  PluginCollectionProjectedScalarFieldRefV1Schema,
  PluginCollectionQuotaRequestV1Schema,
  PluginCollectionRelationV1Schema,
  PluginCollectionScalarKindV1Schema,
  PluginCollectionSchemaVersionV1Schema,
  PluginCollectionUiQueryDescriptorV1Schema,
  PluginCollectionUiQueryParameterV1Schema,
  type PluginAccountCollectionContributionV1,
  type PluginCollectionSchemaVersionV1,
  type PluginCollectionIndexFieldV1,
  type PluginCollectionIndexPrefixQuotaV1,
  type PluginCollectionIndexV1,
  type PluginCollectionMigrationDeclarationV1,
  type PluginCollectionMemberNameV1,
  type PluginCollectionProjectedScalarFieldRefV1,
  type PluginCollectionQuotaRequestV1,
  type PluginCollectionRelationV1,
  type PluginCollectionScalarKindV1,
  type PluginCollectionUiQueryDescriptorV1,
  type PluginCollectionUiQueryParameterV1,
  type PluginCollectionUiQueryValueV1,
} from './collectionContributionV1.js';
export {
  PluginCollectionOpaqueCursorV1Schema,
  PluginCollectionRowIdV1Schema,
  PluginCollectionUiQueryErrorCodeV1Schema,
  PluginCollectionUiQueryErrorV1Schema,
  PluginCollectionUiQueryRequestV1Schema,
  PluginCollectionUiQueryResultV1Schema,
  PluginCollectionUiRowContextV1Schema,
  PluginCollectionUiRowV1Schema,
  type PluginCollectionRowIdV1,
  type PluginCollectionUiQueryErrorCodeV1,
  type PluginCollectionUiQueryErrorV1,
  type PluginCollectionUiQueryRequestV1,
  type PluginCollectionUiQueryResultV1,
  type PluginCollectionUiRowContextV1,
  type PluginCollectionUiRowV1,
} from './collectionUiQueryWireV1.js';

const FiniteNumberSchema = PluginCollectionFiniteNumberV1Schema;
const MAX_COLLECTION_INDEXED_STRING_UTF8_BYTES = 256;
const MAX_COLLECTION_INDEX_TUPLE_PREFIX_BYTES = 2_060;
export const PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1 = 2_318;

export {
  PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
  PLUGIN_COLLECTION_LIMITS_V1,
  PLUGIN_COLLECTION_SCHEMA_VERSION_MAX,
} from './collectionLimitsV1.js';

/**
 * `JSON.stringify` abandons its iterative fast path once the serialization
 * grows past a threshold and finishes recursively, so measuring a large,
 * deeply nested — but perfectly valid and in-budget — Collection payload that
 * way throws `RangeError`. Protocol's serialized-byte owner walks with an
 * explicit stack and produces the same spelling, so the ceilings below refuse
 * or admit on bytes rather than on the shape of the host's serializer.
 */
function encodedJsonUtf8ByteLength(value: unknown): number {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('Collection values must be JSON serializable.');
  }
  return measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'Collection value');
}

/**
 * The canonical encoded size of a parsed mutation request. Server enforcement
 * and the CLI advisory preflight share this exact parsed-wire metric rather
 * than estimating individual operation payloads.
 */
export function measurePluginCollectionMutationRequestEncodedBytesV1(
  request: PluginCollectionMutationRequestV1,
): number {
  return encodedJsonUtf8ByteLength(request);
}

/**
 * The canonical mutation-request metric decomposed into the parts a batch
 * planner recombines: the request shell every batch pays once, and each
 * operation's marginal cost including the separator that joins it to a
 * preceding operation. Costs are additive, so the shell plus any subset of the
 * operation costs, less the one separator the first operation does not pay,
 * is exactly `measurePluginCollectionMutationRequestEncodedBytesV1` of that
 * subset sent as one request.
 */
export type PluginCollectionMutationRequestMeasurementV1 = Readonly<{
  /** Encoded bytes one mutation request costs before any operation. */
  overheadEncodedBytes: number;
  /** Encoded bytes each operation adds, in the order supplied. */
  operationEncodedBytes: readonly number[];
}>;

/**
 * The single decomposition owner for the metric above. Every planner — daemon
 * plugin, plugin UI, or host — reads its batch sizing from here so no surface
 * re-models the private envelope, the projection, or the request shell.
 */
export function measurePluginCollectionMutationRequestDecompositionV1(
  request: PluginCollectionMutationRequestV1,
): PluginCollectionMutationRequestMeasurementV1 {
  return Object.freeze({
    // Spreading keeps the request's own key order, so this is the exact shell
    // the wire would carry with no operations in it.
    overheadEncodedBytes: encodedJsonUtf8ByteLength({ ...request, operations: [] }),
    operationEncodedBytes: Object.freeze(
      request.operations.map((operation) => encodedJsonUtf8ByteLength(operation) + 1),
    ),
  });
}

/**
 * The Account Collection limits actually in force for one bound collection:
 * the connected deployment's published policy narrowed by that collection's
 * admitted quota. The server composes its enforced maximum the same way, so a
 * planner reading this plans against the value that will be enforced rather
 * than a compatibility ceiling.
 *
 * Batch dimensions are deployment-owned: a collection quota bounds stored rows
 * and Account aggregates, never how much one atomic request may carry.
 */
export type PluginCollectionEffectiveLimitsV1 = Readonly<{
  maxRowEncodedBytes: number;
  maxBatchBytes: number;
  maxBatchRows: number;
  maxAccountRows: number;
  maxAccountBytes: number;
  /**
   * `deployment` when the connected deployment published its effective policy.
   * `default` when it has not yet and these are the platform's shipped
   * deployment defaults; an operator may have lowered a dimension the client
   * cannot see, so a batch planned on a `default` basis can still be rejected.
   */
  basis: 'deployment' | 'default';
}>;

/**
 * The single composition owner for the limits a Collection writer plans
 * against. Both the daemon plugin runtime and the plugin-UI Data client
 * resolve through this function so the two surfaces cannot report different
 * effective ceilings for the same bound collection.
 */
export function resolveEffectivePluginCollectionLimitsV1(input: Readonly<{
  deployment: PluginDataCollectionsCapabilities | undefined;
  quota: PluginCollectionQuotaRequestV1 | undefined;
}>): PluginCollectionEffectiveLimitsV1 {
  const deployment = input.deployment ?? PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1;
  const narrowed = (deploymentMaximum: number, requested: number | undefined): number => (
    requested === undefined ? deploymentMaximum : Math.min(deploymentMaximum, requested)
  );
  return Object.freeze({
    maxRowEncodedBytes: narrowed(deployment.maxRowEncodedBytes, input.quota?.maxRowEncodedBytes),
    maxBatchBytes: deployment.maxBatchBytes,
    maxBatchRows: deployment.maxBatchRows,
    maxAccountRows: narrowed(deployment.maxAccountRows, input.quota?.maxRows),
    maxAccountBytes: narrowed(deployment.maxAccountBytes, input.quota?.maxCollectionEncodedBytes),
    basis: input.deployment ? 'deployment' : 'default',
  });
}

/** Stable UTF-16 code-unit order; unlike localeCompare, this cannot vary with process locale. */
function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const OpaqueCollectionCursorSchema = PluginCollectionOpaqueCursorV1Schema;
const ProjectedScalarValueSchema = PluginCollectionProjectedScalarValueV1Schema;

export const PluginCollectionContractDigestV1Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type PluginCollectionContractDigestV1 = z.infer<typeof PluginCollectionContractDigestV1Schema>;

export const PluginCollectionContractRefV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  schemaVersion: PluginCollectionSchemaVersionV1Schema,
  contractDigest: PluginCollectionContractDigestV1Schema,
}).strict();
export type PluginCollectionContractRefV1 = z.infer<typeof PluginCollectionContractRefV1Schema>;

export const PluginCollectionWriterContextV1Schema = z.object({
  schemaVersion: PluginCollectionSchemaVersionV1Schema,
  contractDigest: PluginCollectionContractDigestV1Schema,
}).strict();
export type PluginCollectionWriterContextV1 = z.infer<typeof PluginCollectionWriterContextV1Schema>;

/**
 * Collection rows store server-readable fields separately from the private
 * payload. Plain payloads are object-shaped so the server can reconstruct and
 * validate the logical row without persisting a second copy of a projection.
 */
/**
 * The encrypted Collection payload is a data-local Account-scoped ciphertext
 * over this private object only. Server-readable fields remain in the
 * separately admitted projection and are never copied into another envelope.
 */
export const PLUGIN_COLLECTION_PRIVATE_PAYLOAD_ACCOUNT_SCOPED_BLOB_KIND_V1 =
  'plugin_collection_private_payload' as const;

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
const PluginCollectionMemberValueV1Schema = z.unknown().transform(
  (value, context): PluginJsonValueV2 => {
    try {
      assertStrictPluginJsonValue(value, 'Collection member value');
      return value as PluginJsonValueV2;
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid Collection member value',
      });
      return z.NEVER;
    }
  },
);

export const PluginCollectionPrivatePayloadV1Schema = z.record(
  PluginCollectionMemberNameV1Schema,
  PluginCollectionMemberValueV1Schema,
);
export type PluginCollectionPrivatePayloadV1 = z.infer<typeof PluginCollectionPrivatePayloadV1Schema>;

/** The exact generic Account cipher domain allocated to Collection private row payloads. */
export function sealPluginCollectionPrivatePayloadV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  payload: PluginCollectionPrivatePayloadV1;
  randomBytes: (length: number) => Uint8Array;
}>): string {
  return sealAccountScopedBlobCiphertext({
    kind: PLUGIN_COLLECTION_PRIVATE_PAYLOAD_ACCOUNT_SCOPED_BLOB_KIND_V1,
    material: params.material,
    payload: PluginCollectionPrivatePayloadV1Schema.parse(params.payload),
    randomBytes: params.randomBytes,
  });
}

/**
 * Opens only the exact Collection payload domain and validates the decrypted
 * private object before it reaches SDK split/merge logic. A different
 * Account-scoped domain is never interpreted as a Collection row.
 */
export function openPluginCollectionPrivatePayloadV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  ciphertext: string;
}>): PluginCollectionPrivatePayloadV1 | null {
  const opened = openAccountScopedBlobCiphertext({
    kind: PLUGIN_COLLECTION_PRIVATE_PAYLOAD_ACCOUNT_SCOPED_BLOB_KIND_V1,
    material: params.material,
    ciphertext: params.ciphertext,
  });
  if (!opened) return null;
  const parsed = PluginCollectionPrivatePayloadV1Schema.safeParse(opened.value);
  return parsed.success ? parsed.data : null;
}

export const PluginCollectionContentEnvelopeV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: PluginCollectionPrivatePayloadV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]).superRefine((value, context) => {
  if (encodedJsonUtf8ByteLength(value) > PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Collection private envelope exceeds the 512 KiB encoded limit.',
    });
  }
});
export type PluginCollectionContentEnvelopeV1 = z.infer<typeof PluginCollectionContentEnvelopeV1Schema>;

export class PluginCollectionContentEnvelopeModeMismatchError extends Error {
  constructor() {
    super('Plugin Collection content envelope does not match the Account encryption mode');
    this.name = 'PluginCollectionContentEnvelopeModeMismatchError';
  }
}

export function assertPluginCollectionContentEnvelopeForModeV1(
  input: unknown,
  mode: 'plain' | 'e2ee',
): PluginCollectionContentEnvelopeV1 {
  const envelope = PluginCollectionContentEnvelopeV1Schema.parse(input);
  if (
    (mode === 'plain' && envelope.t !== 'plain')
    || (
      mode === 'e2ee'
      && (
        envelope.t !== 'encrypted'
        || !isAccountScopedBlobCiphertextForKind({
          kind: PLUGIN_COLLECTION_PRIVATE_PAYLOAD_ACCOUNT_SCOPED_BLOB_KIND_V1,
          ciphertext: envelope.c,
        })
      )
    )
  ) {
    throw new PluginCollectionContentEnvelopeModeMismatchError();
  }
  return envelope;
}

/** Only declared server-readable scalar fields cross the mutation boundary. */
export const PluginCollectionProjectionV1Schema = z.record(
  PluginCollectionMemberNameV1Schema,
  ProjectedScalarValueSchema,
).superRefine((value, context) => {
  if (Object.keys(value).length > 16) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A collection projection has too many fields.' });
  }
  if (encodedJsonUtf8ByteLength(value) > PLUGIN_COLLECTION_LIMITS_V1.maximumProjectionEncodedBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Collection projection exceeds the 64 KiB encoded limit.',
    });
  }
});
export type PluginCollectionProjectionV1 = z.infer<typeof PluginCollectionProjectionV1Schema>;

const PluginCollectionRevisionV1Schema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const PluginCollectionExpectedRevisionV1Schema = z.union([
  z.literal('absent'),
  PluginCollectionRevisionV1Schema,
]);

export const PluginCollectionPutMutationV1Schema = z.object({
  kind: z.literal('put'),
  rowId: PluginCollectionRowIdV1Schema,
  expectedRevision: PluginCollectionExpectedRevisionV1Schema,
  content: PluginCollectionContentEnvelopeV1Schema,
  projection: PluginCollectionProjectionV1Schema,
}).strict();
export type PluginCollectionPutMutationV1 = z.infer<typeof PluginCollectionPutMutationV1Schema>;

export const PluginCollectionDeleteMutationV1Schema = z.object({
  kind: z.literal('delete'),
  rowId: PluginCollectionRowIdV1Schema,
  expectedRevision: PluginCollectionRevisionV1Schema,
}).strict();
export type PluginCollectionDeleteMutationV1 = z.infer<typeof PluginCollectionDeleteMutationV1Schema>;

/** A non-mutating exact-currentness precondition for one currently live row. */
export const PluginCollectionBatchAssertV1Schema = z.object({
  kind: z.literal('assert'),
  rowId: PluginCollectionRowIdV1Schema,
  expectedRevision: PluginCollectionRevisionV1Schema,
}).strict();
export type PluginCollectionBatchAssertV1 = z.infer<typeof PluginCollectionBatchAssertV1Schema>;

export const PluginCollectionMutationOperationV1Schema = z.discriminatedUnion('kind', [
  PluginCollectionPutMutationV1Schema,
  PluginCollectionDeleteMutationV1Schema,
  PluginCollectionBatchAssertV1Schema,
]);
export type PluginCollectionMutationOperationV1 = z.infer<typeof PluginCollectionMutationOperationV1Schema>;

/**
 * The host, not plugin-authored row content, stamps the writer context. A
 * batch is bounded and contains each row at most once, which makes the
 * complete conflict set meaningful and keeps server execution one transaction.
 */
export const PluginCollectionMutationRequestV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  writerContext: PluginCollectionWriterContextV1Schema,
  operations: z.array(PluginCollectionMutationOperationV1Schema)
    .min(1)
    .max(PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows),
}).strict().superRefine((value, context) => {
  const rowIds = new Set<string>();
  value.operations.forEach((operation, index) => {
    if (rowIds.has(operation.rowId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations', index, 'rowId'],
        message: 'A collection mutation batch may contain each row at most once.',
      });
    }
    rowIds.add(operation.rowId);
  });
  if (!value.operations.some((operation) => operation.kind !== 'assert')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operations'],
      message: 'A collection mutation batch must contain a put or delete operation.',
    });
  }
  if (encodedJsonUtf8ByteLength(value) > PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchEncodedBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Collection mutation batch exceeds the 64 MiB encoded limit.',
    });
  }
});
export type PluginCollectionMutationRequestV1 = z.infer<typeof PluginCollectionMutationRequestV1Schema>;

export const PluginCollectionMutationResultEntryV1Schema = z.object({
  rowId: PluginCollectionRowIdV1Schema,
  revision: PluginCollectionRevisionV1Schema,
  deleted: z.boolean(),
}).strict();
export type PluginCollectionMutationResultEntryV1 = z.infer<typeof PluginCollectionMutationResultEntryV1Schema>;

export const PluginCollectionMutationConflictV1Schema = z.object({
  rowId: PluginCollectionRowIdV1Schema,
  revision: PluginCollectionRevisionV1Schema.nullable(),
  deleted: z.boolean(),
}).strict();
export type PluginCollectionMutationConflictV1 = z.infer<typeof PluginCollectionMutationConflictV1Schema>;

export const PluginCollectionMutationResultV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('updated'),
    results: z.array(PluginCollectionMutationResultEntryV1Schema).min(1).max(100),
    changeCursor: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal('conflict'),
    conflicts: z.array(PluginCollectionMutationConflictV1Schema).min(1).max(100),
  }).strict(),
]);
export type PluginCollectionMutationResultV1 = z.infer<typeof PluginCollectionMutationResultV1Schema>;

export const PluginCollectionMutationErrorCodeV1Schema = z.enum([
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
]);
export type PluginCollectionMutationErrorCodeV1 = z.infer<typeof PluginCollectionMutationErrorCodeV1Schema>;

/**
 * The named effective limit that made a current Collection state incompatible.
 * These names are shared by mutation and Availability readiness failures.
 */
export const PluginCollectionQuotaDimensionV1Schema = z.enum([
  'maxRowEncodedBytes',
  'maxRows',
  'maxCollectionEncodedBytes',
  'maxBatchRows',
  'maxBatchBytes',
  'maxAccountRows',
  'maxAccountBytes',
]);
export type PluginCollectionQuotaDimensionV1 = z.infer<typeof PluginCollectionQuotaDimensionV1Schema>;

export const PluginCollectionQuotaIncompatibleErrorV1Schema = z.object({
  error: z.literal('collection_quota_incompatible'),
  dimension: PluginCollectionQuotaDimensionV1Schema,
  effectiveMaximum: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type PluginCollectionQuotaIncompatibleErrorV1 = z.infer<
  typeof PluginCollectionQuotaIncompatibleErrorV1Schema
>;

/**
 * A restricted relation carries one fully specified page over its existing
 * source Collection index. Callers reuse the ordinary Collection query and
 * cursor; this schema does not introduce another paging protocol.
 */
export const PluginCollectionRelationRestrictionQueryV1Schema = z.object({
  indexId: PluginCollectionMemberNameV1Schema,
  prefix: z.array(PluginCollectionRowIdV1Schema).length(1),
  order: z.literal('asc'),
  limit: z.number().int().min(1).max(200),
}).strict();
export type PluginCollectionRelationRestrictionQueryV1 = z.infer<
  typeof PluginCollectionRelationRestrictionQueryV1Schema
>;

export const PluginCollectionRelationRestrictionContinuationV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  relationId: PluginCollectionMemberNameV1Schema,
  target: z.object({
    collectionId: asProtocolZod(PluginContributionLocalIdSchema),
    rowId: PluginCollectionRowIdV1Schema,
  }).strict(),
  query: PluginCollectionRelationRestrictionQueryV1Schema,
}).strict();
export type PluginCollectionRelationRestrictionContinuationV1 = z.infer<
  typeof PluginCollectionRelationRestrictionContinuationV1Schema
>;

const PluginCollectionSimpleMutationErrorCodeV1Schema = z.enum([
  'collection_mutation_invalid',
  'collection_unavailable',
  'collection_writer_contract_unavailable',
  'collection_index_not_ready',
  'collection_relation_unavailable',
  'collection_content_mode_mismatch',
  'collection_quota_exceeded',
  'collection_contract_inconsistent',
]);

export const PluginCollectionMutationErrorV1Schema = z.union([
  z.object({
    error: PluginCollectionSimpleMutationErrorCodeV1Schema,
  }).strict(),
  PluginCollectionQuotaIncompatibleErrorV1Schema,
  z.object({
    error: z.literal('collection_relation_restricted'),
    dependentCount: z.number().int().min(1).max(200),
    continuation: PluginCollectionRelationRestrictionContinuationV1Schema,
  }).strict(),
]);
export type PluginCollectionMutationErrorV1 = z.infer<typeof PluginCollectionMutationErrorV1Schema>;

/** One decoded collection row at the direct authenticated Data boundary. */
export const PluginCollectionRowV1Schema = z.object({
  rowId: PluginCollectionRowIdV1Schema,
  revision: PluginCollectionRevisionV1Schema,
  content: PluginCollectionContentEnvelopeV1Schema,
  projection: PluginCollectionProjectionV1Schema,
}).strict();
export type PluginCollectionRowV1 = z.infer<typeof PluginCollectionRowV1Schema>;

/** Scalar inputs are validated against the selected admitted index by the canonical query owner. */
export const PluginCollectionIndexScalarValueV1Schema = z.union([
  z.null(),
  z.boolean(),
  z.string(),
  FiniteNumberSchema,
]);
export type PluginCollectionIndexScalarValueV1 = z.infer<typeof PluginCollectionIndexScalarValueV1Schema>;

/**
 * The authenticated Collection transport is one shared contract for daemon
 * and native clients. The SDK host stamps qualified identity and writer
 * context; plugin code never discovers or probes these endpoints.
 */
export const PLUGIN_COLLECTION_GET_HTTP_PATH_V1 = '/v1/plugins/data/get';
export const PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1 = '/v1/plugins/data/mutate';
export const PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1 = '/v1/plugins/data/query';

/**
 * Candidate preparation stays host-owned: authenticated transport resolves the
 * Account, while these opaque facts bind one selected candidate rather than
 * granting callers any release or activation authority.
 */
const PluginCollectionCandidatePreparationOpaqueIdentityV1Schema = z.string()
  .min(1)
  .max(256)
  .refine(
    (value) => value.trim() === value && !value.includes('\u0000'),
    'Candidate preparation identities must be non-empty, unpadded, and NUL-free.',
  );

/**
 * One immutable source/target/candidate binding for a host-owned Collection
 * migration attempt. The server verifies this host-stamped binding against
 * current Account, Availability, and contract state before admitting any read
 * or target stage; it does not select a candidate or activate a contract.
 */
export const PluginCollectionCandidatePreparationBindingV1Schema = z.object({
  source: PluginCollectionContractRefV1Schema,
  target: PluginCollectionContractRefV1Schema,
  candidate: z.object({
    releaseVersion: PluginCollectionCandidatePreparationOpaqueIdentityV1Schema,
    /**
     * Exact public target artifact/graph digest. This is a Data-stage
     * identity, never the daemon's private immutable generation id.
     */
    artifactDigest: PluginUiArtifactDigestV1Schema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.source.pluginId !== value.target.pluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target', 'pluginId'],
      message: 'Candidate preparation source and target must belong to one plugin.',
    });
  }
  if (value.source.collectionId !== value.target.collectionId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target', 'collectionId'],
      message: 'Candidate preparation source and target must name one collection.',
    });
  }
});
export type PluginCollectionCandidatePreparationBindingV1 = z.infer<
  typeof PluginCollectionCandidatePreparationBindingV1Schema
>;

export const PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1 =
  '/v1/plugins/data/candidate-preparation/source-page';
export const PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1 =
  '/v1/plugins/data/candidate-preparation/stage';
export const PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1 =
  '/v1/plugins/data/candidate-preparation/retire';

/**
 * A bounded page of source rows for the target-artifact host. The opaque
 * cursor remains server-owned; callbacks and logical plaintext values never
 * appear as separately caller-controlled wire fields.
 */
export const PluginCollectionCandidatePreparationSourcePageRequestV1Schema = z.object({
  binding: PluginCollectionCandidatePreparationBindingV1Schema,
  cursor: OpaqueCollectionCursorSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export type PluginCollectionCandidatePreparationSourcePageRequestV1 = z.infer<
  typeof PluginCollectionCandidatePreparationSourcePageRequestV1Schema
>;

/**
 * A server-derived rejoin fact for this exact binding and source revision.
 * It exposes no staged target material: a host skips its pure callback when
 * true and otherwise lets the exact-revision stage CAS arbitrate a race.
 */
const PluginCollectionCandidatePreparationSourcePageRowV1Schema = PluginCollectionRowV1Schema.extend({
  alreadyStaged: z.boolean(),
});

export const PluginCollectionCandidatePreparationSourcePageResultV1Schema = z.object({
  rows: z.array(PluginCollectionCandidatePreparationSourcePageRowV1Schema).max(200),
  nextCursor: OpaqueCollectionCursorSchema.optional(),
}).strict();
export type PluginCollectionCandidatePreparationSourcePageResultV1 = z.infer<
  typeof PluginCollectionCandidatePreparationSourcePageResultV1Schema
>;

const PluginCollectionCandidatePreparationSourceRowRefV1Schema = PluginCollectionRowV1Schema.pick({
  rowId: true,
  revision: true,
});
const PluginCollectionCandidatePreparationTargetRowV1Schema = PluginCollectionRowV1Schema.pick({
  content: true,
  projection: true,
});

const PluginCollectionCandidatePreparationStageItemV1Schema = z.object({
  source: PluginCollectionCandidatePreparationSourceRowRefV1Schema,
  target: PluginCollectionCandidatePreparationTargetRowV1Schema,
}).strict();

/**
 * The target-artifact host stages bounded target envelopes and projections
 * against observed source revisions. Neither this request nor its response
 * replaces the incumbent canonical row or writable contract.
 */
export const PluginCollectionCandidatePreparationStageRequestV1Schema = z.object({
  binding: PluginCollectionCandidatePreparationBindingV1Schema,
  items: z.array(PluginCollectionCandidatePreparationStageItemV1Schema)
    .min(1)
    .max(PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows),
}).strict();
export type PluginCollectionCandidatePreparationStageRequestV1 = z.infer<
  typeof PluginCollectionCandidatePreparationStageRequestV1Schema
>;

/**
 * The canonical encoded size of a parsed candidate-stage request. Server
 * admission measures this exact envelope once against the deployment batch
 * limit instead of estimating its individual target rows.
 */
export function measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
  request: PluginCollectionCandidatePreparationStageRequestV1,
): number {
  return encodedJsonUtf8ByteLength(request);
}

/**
 * Greedily groups target-stage items into the largest requests that fit the
 * currently advertised deployment limits. It deliberately preserves a
 * singleton that does not fit: the server remains the authoritative owner of
 * that typed refusal because no smaller valid request shape exists.
 */
export function splitPluginCollectionCandidatePreparationStageRequestsForKnownLimitsV1(input: Readonly<{
  binding: PluginCollectionCandidatePreparationBindingV1;
  items: readonly PluginCollectionCandidatePreparationStageRequestV1['items'][number][];
  limits: Readonly<{
    maxBatchRows: number;
    maxBatchBytes: number;
  }>;
}>): readonly PluginCollectionCandidatePreparationStageRequestV1[] {
  const requests: PluginCollectionCandidatePreparationStageRequestV1[] = [];
  let pending: PluginCollectionCandidatePreparationStageRequestV1['items'][number][] = [];
  const toRequest = (items: readonly PluginCollectionCandidatePreparationStageRequestV1['items'][number][]) => (
    PluginCollectionCandidatePreparationStageRequestV1Schema.parse({
      binding: input.binding,
      items,
    })
  );

  for (const item of input.items) {
    const candidate = toRequest([...pending, item]);
    const exceedsKnownLimit = candidate.items.length > input.limits.maxBatchRows
      || measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(candidate)
        > input.limits.maxBatchBytes;
    if (exceedsKnownLimit && pending.length > 0) {
      requests.push(toRequest(pending));
      pending = [item];
    } else {
      pending.push(item);
    }
  }
  if (pending.length > 0) requests.push(toRequest(pending));
  return requests;
}

const PluginCollectionCandidatePreparationStageItemResultV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('staged') }).strict(),
  z.object({ status: z.literal('sourceChanged') }).strict(),
]);

export const PluginCollectionCandidatePreparationStageResultV1Schema = z.object({
  results: z.array(PluginCollectionCandidatePreparationStageItemResultV1Schema)
    .min(1)
    .max(PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows),
}).strict();
export type PluginCollectionCandidatePreparationStageResultV1 = z.infer<
  typeof PluginCollectionCandidatePreparationStageResultV1Schema
>;

/**
 * Idempotently removes only the target stages named by one exact host-stamped
 * binding. The authenticated Account and lifecycle reason stay server-owned;
 * retirement neither reports stage existence nor changes activation state.
 */
export const PluginCollectionCandidatePreparationRetireRequestV1Schema = z.object({
  binding: PluginCollectionCandidatePreparationBindingV1Schema,
}).strict();
export type PluginCollectionCandidatePreparationRetireRequestV1 = z.infer<
  typeof PluginCollectionCandidatePreparationRetireRequestV1Schema
>;

export const PluginCollectionCandidatePreparationRetireResultV1Schema = z.object({
  status: z.literal('retired'),
}).strict();
export type PluginCollectionCandidatePreparationRetireResultV1 = z.infer<
  typeof PluginCollectionCandidatePreparationRetireResultV1Schema
>;

const PluginCollectionCandidatePreparationSimpleErrorCodeV1Schema = z.enum([
  'collection_candidate_preparation_invalid',
  'collection_candidate_preparation_unavailable',
  'collection_candidate_preparation_source_changed',
  'collection_candidate_preparation_contract_mismatch',
  'collection_candidate_preparation_content_mode_mismatch',
  'collection_candidate_preparation_cursor_invalid',
  'collection_quota_exceeded',
]);

/**
 * Typed terminal refusal for either host-owned candidate-preparation
 * operation. The detailed quota incompatibility arm is the existing Collection
 * quota owner so source-plus-stage admission cannot acquire a parallel shape.
 */
export const PluginCollectionCandidatePreparationErrorV1Schema = z.union([
  z.object({ error: PluginCollectionCandidatePreparationSimpleErrorCodeV1Schema }).strict(),
  PluginCollectionQuotaIncompatibleErrorV1Schema,
]);
export type PluginCollectionCandidatePreparationErrorV1 = z.infer<
  typeof PluginCollectionCandidatePreparationErrorV1Schema
>;

export const PluginCollectionGetRequestV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  rowId: PluginCollectionRowIdV1Schema,
}).strict();
export type PluginCollectionGetRequestV1 = z.infer<typeof PluginCollectionGetRequestV1Schema>;

export const PluginCollectionGetResultV1Schema = z.object({
  row: PluginCollectionRowV1Schema.nullable(),
}).strict();
export type PluginCollectionGetResultV1 = z.infer<typeof PluginCollectionGetResultV1Schema>;

export const PluginCollectionQueryRangeV1Schema = z.object({
  lower: PluginCollectionIndexScalarValueV1Schema.optional(),
  upper: PluginCollectionIndexScalarValueV1Schema.optional(),
}).strict().refine(
  (value) => value.lower !== undefined || value.upper !== undefined,
  'A collection query range needs a lower or upper bound.',
);
export type PluginCollectionQueryRangeV1 = z.infer<typeof PluginCollectionQueryRangeV1Schema>;

/**
 * The host stamps the qualified collection identity; plugin authors can only
 * supply bounded logical index values, order, cursor, and page size. Contract
 * and Account authority are intentionally absent from this wire shape.
 */
export const PluginCollectionQueryRequestV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  indexId: PluginCollectionMemberNameV1Schema,
  prefix: z.array(PluginCollectionIndexScalarValueV1Schema).max(4).default([]),
  range: PluginCollectionQueryRangeV1Schema.optional(),
  order: z.enum(['asc', 'desc']),
  cursor: OpaqueCollectionCursorSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export type PluginCollectionQueryRequestV1 = z.infer<typeof PluginCollectionQueryRequestV1Schema>;

export const PluginCollectionQueryResultV1Schema = z.object({
  rows: z.array(PluginCollectionRowV1Schema).max(200),
  nextCursor: OpaqueCollectionCursorSchema.optional(),
  changeCursor: z.number().int().nonnegative(),
}).strict();
export type PluginCollectionQueryResultV1 = z.infer<typeof PluginCollectionQueryResultV1Schema>;

/**
 * Direct get/query and the constrained static UI query share one terminal
 * read-error union. Their materialization/privacy contracts remain distinct;
 * aliases retain the direct wire names without giving either adapter a second
 * error-schema owner.
 */
export const PluginCollectionReadErrorCodeV1Schema = PluginCollectionUiQueryErrorCodeV1Schema;
export type PluginCollectionReadErrorCodeV1 = PluginCollectionUiQueryErrorCodeV1;

export const PluginCollectionReadErrorV1Schema = PluginCollectionUiQueryErrorV1Schema;
export type PluginCollectionReadErrorV1 = PluginCollectionUiQueryErrorV1;

export type PluginCollectionIndexScalarV1 = Readonly<{
  kind: PluginCollectionScalarKindV1;
  value: PluginCollectionIndexScalarValueV1;
  direction?: 'asc' | 'desc';
}>;

/**
 * Exact immutable UI-query descriptor emitted from a normalized collection
 * contract. This is deliberately distinct from the manifest declaration: it
 * carries the host-stamped collection identity and typed projected fields that
 * realm adapters consume without reinterpreting the author manifest.
 */
export const NormalizedPluginCollectionUiQueryDescriptorV1Schema = z.object({
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
  pageSize: z.number().int().min(1).max(200),
  projectedFields: z.array(PluginCollectionProjectedScalarFieldRefV1Schema).min(1).max(16),
}).strict().superRefine((value, context) => {
  if (new Set(value.projectedFields.map((field) => field.field)).size !== value.projectedFields.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['projectedFields'],
      message: 'Projected fields must be unique.',
    });
  }
});
export type NormalizedPluginCollectionUiQueryDescriptorV1 = z.infer<
  typeof NormalizedPluginCollectionUiQueryDescriptorV1Schema
>;

const COLLECTION_OBJECT_ROOT_SCHEMA_MESSAGE = 'Collection schemas must be object schemas with declared properties.';

function collectionObjectProperties(
  schema: PluginJsonSchemaV2,
): Readonly<Record<string, PluginJsonSchemaV2>> | null {
  return schema.type === 'object' && schema.properties !== undefined
    ? schema.properties
    : null;
}

/**
 * The immutable contract shape reconstructed by the Data owner from persisted
 * columns. Realm clients consume it only after an exact ref has been admitted;
 * this schema never accepts an author manifest as a substitute.
 */
export const NormalizedPluginAccountCollectionContractV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  schemaVersion: PluginCollectionSchemaVersionV1Schema,
  migrations: z.array(PluginCollectionMigrationDeclarationV1Schema).default([]),
  contractDigest: PluginCollectionContractDigestV1Schema,
  rowIdField: PluginCollectionMemberNameV1Schema,
  schema: PluginCollectionSchemaV1Schema,
  serverReadable: z.array(PluginCollectionMemberNameV1Schema),
  indexes: z.array(PluginCollectionIndexV1Schema),
  uiQueries: z.array(NormalizedPluginCollectionUiQueryDescriptorV1Schema),
  relations: z.array(PluginCollectionRelationV1Schema),
  quota: PluginCollectionQuotaRequestV1Schema.optional(),
  readableSchemaVersions: z.array(PluginCollectionSchemaVersionV1Schema),
  identityFields: z.array(PluginCollectionMemberNameV1Schema).default([]),
}).strict().superRefine((value, context) => {
  if (collectionObjectProperties(value.schema) === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['schema'],
      message: COLLECTION_OBJECT_ROOT_SCHEMA_MESSAGE,
    });
  }
});

export type NormalizedPluginAccountCollectionContractV1 = Readonly<{
  pluginId: string;
  collectionId: string;
  schemaVersion: number;
  migrations: readonly PluginCollectionMigrationDeclarationV1[];
  contractDigest: string;
  rowIdField: string;
  schema: PluginJsonSchemaV2;
  serverReadable: readonly string[];
  indexes: readonly Readonly<{
    id: string;
    fields: readonly Readonly<{ field: string; direction: 'asc' | 'desc' }>[];
  }> [];
  uiQueries: readonly NormalizedPluginCollectionUiQueryDescriptorV1[];
  relations: readonly PluginCollectionRelationV1[];
  quota?: PluginCollectionQuotaRequestV1;
  readableSchemaVersions: readonly number[];
  /**
   * Fields whose stored value is a mode-derived identity tag. Non-empty means
   * this collection's live rows cannot survive an Account encryption-mode
   * transition: the platform cannot recompute the addresses they would move to.
   */
  identityFields: readonly string[];
}>;

/** Exact authenticated read of one release-admitted persisted contract. */
export const PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1 = '/v1/plugins/data/contract';

export const PluginCollectionContractReadRequestV1Schema = z.object({
  ref: PluginCollectionContractRefV1Schema,
}).strict();
export type PluginCollectionContractReadRequestV1 = z.infer<typeof PluginCollectionContractReadRequestV1Schema>;

export const PluginCollectionContractReadResultV1Schema = z.object({
  contract: NormalizedPluginAccountCollectionContractV1Schema,
}).strict();
export type PluginCollectionContractReadResultV1 = z.infer<typeof PluginCollectionContractReadResultV1Schema>;

type ScalarKind = PluginCollectionScalarKindV1;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('Expected canonical JSON value.');
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function normalizeSchema(value: PluginJsonSchemaV2, isCollectionRoot = true): PluginJsonSchemaV2 {
  if (Array.isArray(value)) return value.map((schema) => normalizeSchema(schema, false)) as never;
  const object = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object).sort(([left], [right]) => compareCanonicalText(left, right))) {
    if (key === 'properties' && item && typeof item === 'object' && !Array.isArray(item)) {
      normalized[key] = Object.fromEntries(Object.entries(item as Record<string, PluginJsonSchemaV2>)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([property, schema]) => [property, normalizeSchema(schema, false)]));
    } else if ((key === 'required' || key === 'enum') && Array.isArray(item)) {
      normalized[key] = [...item].sort((left, right) => compareCanonicalText(canonicalJson(left), canonicalJson(right)));
    } else if (Array.isArray(item)) {
      normalized[key] = item.map((entry) => entry && typeof entry === 'object'
        ? normalizeSchema(entry as PluginJsonSchemaV2, false)
        : entry);
    } else if (item && typeof item === 'object') {
      normalized[key] = normalizeSchema(item as PluginJsonSchemaV2, false);
    } else {
      normalized[key] = item;
    }
  }
  return (isCollectionRoot ? PluginCollectionSchemaV1Schema : PluginJsonSchemaV2Schema).parse(normalized);
}

export function getPluginCollectionScalarKindV1(input: Readonly<{
  schema: PluginJsonSchemaV2;
  field: string;
}>): PluginCollectionScalarKindV1 {
  const { schema, field } = input;
  const properties = collectionObjectProperties(schema);
  if (properties === null) throw new Error(COLLECTION_OBJECT_ROOT_SCHEMA_MESSAGE);
  const fieldSchema = properties[field];
  if (!fieldSchema) throw new Error(`Collection field "${field}" is not declared by the schema.`);
  if (fieldSchema.type === 'string') return fieldSchema.format === 'date-time' ? 'instant' : 'string';
  if (fieldSchema.type === 'boolean') return 'boolean';
  if (fieldSchema.type === 'number' || fieldSchema.type === 'integer') return 'finiteNumber';
  const literalUnionKind = getSameKindLiteralUnionScalarKind(fieldSchema);
  if (literalUnionKind) return literalUnionKind;
  throw new Error(`Collection field "${field}" is not a supported scalar.`);
}

/**
 * `defineProtocolUnion([defineProtocolLiteral(...), ...])` projects to this
 * exact shape. Accept it at the Collection normalization boundary without
 * making arbitrary JSON Schema unions scalar-capable.
 */
function getSameKindLiteralUnionScalarKind(schema: PluginJsonSchemaV2): ScalarKind | null {
  if (Object.keys(schema).length !== 1 || !schema.anyOf || schema.anyOf.length < 2) return null;

  let kind: ScalarKind | null = null;
  for (const member of schema.anyOf) {
    if (Object.keys(member).length !== 1 || !Object.hasOwn(member, 'const')) return null;
    const literal = member.const;
    const memberKind = typeof literal === 'string'
      ? 'string'
      : typeof literal === 'boolean'
        ? 'boolean'
        : typeof literal === 'number' && Number.isFinite(literal)
          ? 'finiteNumber'
          : null;
    if (!memberKind || (kind !== null && kind !== memberKind)) return null;
    kind = memberKind;
  }
  return kind;
}

function normalizeParameter(parameter: PluginCollectionUiQueryParameterV1): PluginCollectionUiQueryParameterV1 {
  if (parameter.kind !== 'string' || !parameter.enum) return parameter;
  return { ...parameter, enum: [...parameter.enum].sort(compareCanonicalText) };
}

function validateQueryValue(value: PluginCollectionUiQueryValueV1, parameterKinds: Readonly<Record<string, ScalarKind>>, expectedKind: ScalarKind): void {
  if (value.kind === 'parameter') {
    if (parameterKinds[value.parameterId] === undefined) throw new Error(`UI query references unknown parameter "${value.parameterId}".`);
    if (parameterKinds[value.parameterId] !== expectedKind) throw new Error(`UI query parameter "${value.parameterId}" does not match its index field.`);
    return;
  }
  if (value.value === null) return;
  const actualKind = typeof value.value === 'number' ? 'finiteNumber' : typeof value.value;
  if (actualKind !== expectedKind) throw new Error('UI query literal does not match its index field.');
}

function normalizeQuery(
  query: PluginCollectionUiQueryDescriptorV1,
  index: PluginCollectionIndexV1,
  schema: PluginJsonSchemaV2,
  serverReadable: ReadonlySet<string>,
  collection: NormalizedPluginCollectionUiQueryDescriptorV1['collection'],
): NormalizedPluginCollectionUiQueryDescriptorV1 {
  if (query.prefix.length > index.fields.length) throw new Error(`UI query "${query.id}" has an overlong prefix.`);
  const parameterKinds = Object.fromEntries(Object.entries(query.parameters)
    .map(([id, parameter]) => [id, parameter.kind] as const)) as Record<string, ScalarKind>;
  query.prefix.forEach((value, position) => validateQueryValue(
    value,
    parameterKinds,
    getPluginCollectionScalarKindV1({ schema, field: index.fields[position]!.field }),
  ));
  const rangeField = index.fields[query.prefix.length]?.field;
  if (query.range && !rangeField) throw new Error(`UI query "${query.id}" cannot range beyond its index.`);
  if (query.range && rangeField) {
    const scalarKind = getPluginCollectionScalarKindV1({ schema, field: rangeField });
    if (query.range.lower) validateQueryValue(query.range.lower, parameterKinds, scalarKind);
    if (query.range.upper) validateQueryValue(query.range.upper, parameterKinds, scalarKind);
  }
  const projectedFields = query.projectedFields.map((field) => {
    if (!serverReadable.has(field)) throw new Error(`UI query "${query.id}" projects undeclared field "${field}".`);
    return { field, kind: getPluginCollectionScalarKindV1({ schema, field }) };
  }).sort((left, right) => compareCanonicalText(left.field, right.field));
  return NormalizedPluginCollectionUiQueryDescriptorV1Schema.parse({
    collection,
    id: query.id,
    indexId: query.indexId,
    parameters: Object.fromEntries(Object.entries(query.parameters)
      .sort(([left], [right]) => compareCanonicalText(left, right))
      .map(([id, parameter]) => [id, normalizeParameter(parameter)])),
    prefix: query.prefix,
    ...(query.range ? { range: query.range } : {}),
    order: query.order,
    pageSize: query.pageSize,
    projectedFields,
  });
}

function canonicalizeQuotaPrefixValue(value: PluginCollectionIndexScalarValueV1): PluginCollectionIndexScalarValueV1 {
  return typeof value === 'number' && Object.is(value, -0) ? 0 : value;
}

function normalizeCollectionQuota(input: Readonly<{
  quota: PluginCollectionQuotaRequestV1 | undefined;
  indexes: readonly PluginCollectionIndexV1[];
  schema: PluginJsonSchemaV2;
}>): PluginCollectionQuotaRequestV1 | undefined {
  if (!input.quota) return undefined;
  const declared = input.quota.maxRowsByIndexPrefix;
  if (!declared) return input.quota;

  const normalized = declared.map((entry) => {
    const index = input.indexes.find((candidate) => candidate.id === entry.indexId);
    if (!index) {
      throw new Error(`Collection quota names unknown index "${entry.indexId}".`);
    }
    if (entry.prefix.length > index.fields.length) {
      throw new Error(`Collection quota prefix for index "${entry.indexId}" exceeds its declared fields.`);
    }
    const fields = entry.prefix.map((value, position) => {
      const indexField = index.fields[position];
      if (!indexField) {
        throw new Error(`Collection quota prefix for index "${entry.indexId}" exceeds its declared fields.`);
      }
      return {
        kind: getPluginCollectionScalarKindV1({ schema: input.schema, field: indexField.field }),
        value: canonicalizeQuotaPrefixValue(value),
        direction: indexField.direction,
      } satisfies PluginCollectionIndexScalarV1;
    });
    let encodedPrefix: Uint8Array;
    try {
      encodedPrefix = encodePluginCollectionIndexTuplePrefixV1({ fields });
    } catch {
      throw new Error(`Collection quota prefix for index "${entry.indexId}" does not match its declared scalar fields.`);
    }
    const normalizedEntry: PluginCollectionIndexPrefixQuotaV1 = {
      indexId: entry.indexId,
      prefix: fields.map((field) => field.value),
      maxRows: entry.maxRows,
    };
    return { entry: normalizedEntry, encodedPrefix };
  }).sort((left, right) => (
    compareCanonicalText(left.entry.indexId, right.entry.indexId)
    || comparePluginCollectionIndexSortKeysV1(left.encodedPrefix, right.encodedPrefix)
  ));

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]!;
    const current = normalized[index]!;
    if (
      previous.entry.indexId === current.entry.indexId
      && comparePluginCollectionIndexSortKeysV1(previous.encodedPrefix, current.encodedPrefix) === 0
    ) {
      throw new Error('Collection quota contains a duplicate canonical index prefix.');
    }
  }

  return PluginCollectionQuotaRequestV1Schema.parse({
    ...(input.quota.maxRows !== undefined ? { maxRows: input.quota.maxRows } : {}),
    ...(input.quota.maxCollectionEncodedBytes !== undefined
      ? { maxCollectionEncodedBytes: input.quota.maxCollectionEncodedBytes }
      : {}),
    ...(input.quota.maxRowEncodedBytes !== undefined
      ? { maxRowEncodedBytes: input.quota.maxRowEncodedBytes }
      : {}),
    maxRowsByIndexPrefix: normalized.map((item) => item.entry),
  });
}

/**
 * Canonical static collection contract owner. It is deliberately pure: server persistence,
 * current writable-contract selection, and realm adapters consume this value rather than
 * reinterpreting an author declaration.
 */
export function normalizePluginAccountCollectionContractV1(input: Readonly<{
  pluginId: string;
  contribution: PluginAccountCollectionContributionV1;
}>): NormalizedPluginAccountCollectionContractV1 {
  const pluginId = PluginIdSchema.parse(input.pluginId);
  const contribution = PluginAccountCollectionContributionV1Schema.parse(input.contribution);
  const schema = normalizeSchema(contribution.schema);
  const rowIdKind = getPluginCollectionScalarKindV1({ schema, field: contribution.rowIdField });
  if (rowIdKind !== 'string') throw new Error('Collection rowIdField must be a string field.');
  const serverReadable = [...contribution.serverReadable].sort(compareCanonicalText);
  for (const field of serverReadable) getPluginCollectionScalarKindV1({ schema, field });
  const serverReadableSet = new Set(serverReadable);
  const relations = contribution.relations.map((relation) => (
    relation.kind === 'collection'
      ? { ...relation, unique: relation.unique ?? false }
      : { ...relation }
  ))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  for (const relation of relations) {
    if (!serverReadableSet.has(relation.field)) {
      throw new Error(`Relation "${relation.id}" includes undeclared server-readable field "${relation.field}".`);
    }
    if (getPluginCollectionScalarKindV1({ schema, field: relation.field }) !== 'string') {
      throw new Error(`Relation "${relation.id}" must use a string identity field.`);
    }
  }
  const indexes = contribution.indexes
    .map((index) => ({ id: index.id, fields: index.fields.map((field) => ({ ...field })) }))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  const indexById = new Map(indexes.map((index) => [index.id, index]));
  for (const index of indexes) {
    for (const field of index.fields) {
      if (!serverReadableSet.has(field.field) && field.field !== contribution.rowIdField) {
        throw new Error(`Index "${index.id}" includes undeclared server-readable field "${field.field}".`);
      }
      getPluginCollectionScalarKindV1({ schema, field: field.field });
    }
  }
  for (const relation of relations) {
    if (
      relation.kind === 'collection'
      && relation.onDelete === 'restrict'
      && !indexes.some((index) => index.fields[0]?.field === relation.field)
    ) {
      throw new Error(
        `Relation "${relation.id}" needs an index whose leading field is "${relation.field}" for its restrict continuation.`,
      );
    }
  }
  const uiQueries = contribution.uiQueries.map((query) => {
    const index = indexById.get(query.indexId);
    if (!index) throw new Error(`UI query "${query.id}" names unknown index "${query.indexId}".`);
    return normalizeQuery(query, index, schema, serverReadableSet, {
      pluginId,
      collectionId: contribution.id,
    });
  }).sort((left, right) => compareCanonicalText(left.id, right.id));
  const quota = normalizeCollectionQuota({
    quota: contribution.quota,
    indexes,
    schema,
  });
  const readableSchemaVersions = [...new Set([
    contribution.schemaVersion,
    ...(contribution.readableSchemaVersions ?? []),
  ])].sort((left, right) => left - right);
  const migrations = contribution.migrations.map((migration) => ({ ...migration }));
  const identityFields = [...new Set(contribution.identityFields)]
    .sort((left, right) => compareCanonicalText(left, right));
  const canonical = {
    pluginId,
    collectionId: contribution.id,
    schemaVersion: contribution.schemaVersion,
    rowIdField: contribution.rowIdField,
    schema,
    serverReadable,
    indexes,
    uiQueries,
    relations,
    ...(quota ? { quota } : {}),
    readableSchemaVersions,
  };
  // Empty migration and identity declarations are semantically absent, so
  // legacy persisted contracts retain their established digest. A non-empty
  // migration chain or mode-derived identity set is part of the immutable
  // target contract and therefore changes the digest.
  const contractDigest = PluginCollectionContractDigestV1Schema.parse(
    computeCanonicalDomainSeparatedDigest('happier.plugin.collection-contract.v1', [canonicalJson({
      ...canonical,
      ...(migrations.length === 0 ? {} : { migrations }),
      ...(identityFields.length === 0 ? {} : { identityFields }),
    })]),
  );
  return Object.freeze({ ...canonical, migrations, identityFields, contractDigest });
}

/**
 * The sole ordered contract-set projection consumed by Account intent and
 * realm adapters. It is release-independent and contains no readiness or
 * current-writer decision.
 */
export function normalizePluginAccountCollectionContractsV1(input: Readonly<{
  pluginId: string;
  contributions: readonly PluginAccountCollectionContributionV1[];
}>): readonly NormalizedPluginAccountCollectionContractV1[] {
  if (input.contributions.length > 32) {
    throw new Error('At most 32 account collection contributions are allowed.');
  }
  const collectionIds = new Set<string>();
  for (const contribution of input.contributions) {
    if (collectionIds.has(contribution.id)) {
      throw new Error('Duplicate account collection contribution id');
    }
    collectionIds.add(contribution.id);
  }
  const contracts = input.contributions
    .map((contribution) => normalizePluginAccountCollectionContractV1({
      pluginId: input.pluginId,
      contribution,
    }))
    .sort((left, right) => compareCanonicalText(left.collectionId, right.collectionId));
  const knownCollectionIds = new Set(contracts.map((contract) => contract.collectionId));
  for (const contract of contracts) {
    for (const relation of contract.relations) {
      if (relation.kind === 'collection' && !knownCollectionIds.has(relation.collectionId)) {
        throw new Error(`Relation "${relation.id}" targets undeclared collection "${relation.collectionId}".`);
      }
    }
  }
  return Object.freeze(contracts);
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

export function isCanonicalPluginCollectionIndexedInstantV1(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
}

function encodeIndexedString(value: string): Uint8Array {
  const utf8 = new TextEncoder().encode(value);
  if (utf8.byteLength > MAX_COLLECTION_INDEXED_STRING_UTF8_BYTES) {
    throw new Error('Indexed string exceeds the 256-byte limit.');
  }
  const bytes: number[] = [];
  for (const byte of utf8) {
    if (byte === 0) {
      bytes.push(0, 0xff);
    } else {
      bytes.push(byte);
    }
  }
  bytes.push(0, 0);
  return Uint8Array.from(bytes);
}

function encodeSignedInt64Ascending(value: bigint): Uint8Array {
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (value < min || value > max) throw new Error('Indexed instant is outside int64 range.');
  let shifted = value + (1n << 63n);
  const bytes = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(shifted & 0xffn);
    shifted >>= 8n;
  }
  return bytes;
}

function encodeFiniteNumberAscending(value: number): Uint8Array {
  if (!Number.isFinite(value)) throw new Error('Indexed number must be finite.');
  const normalized = Object.is(value, -0) ? 0 : value;
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, normalized, false);
  if ((bytes[0]! & 0x80) !== 0) {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (~bytes[index]!) & 0xff;
    }
  } else {
    bytes[0] = bytes[0]! ^ 0x80;
  }
  return bytes;
}

function encodeIndexedScalar(value: PluginCollectionIndexScalarV1): Uint8Array {
  if (value.value === null) return Uint8Array.of(0);
  const prefix = [1];
  switch (value.kind) {
    case 'boolean':
      if (typeof value.value !== 'boolean') throw new Error('Indexed boolean does not match its scalar kind.');
      return Uint8Array.from([...prefix, value.value ? 1 : 0]);
    case 'finiteNumber':
      if (typeof value.value !== 'number') throw new Error('Indexed number does not match its scalar kind.');
      return Uint8Array.from([...prefix, ...encodeFiniteNumberAscending(value.value)]);
    case 'instant': {
      if (typeof value.value !== 'string' || !isCanonicalPluginCollectionIndexedInstantV1(value.value)) {
        throw new Error('Indexed instant does not match its scalar kind.');
      }
      const epochMs = Date.parse(value.value);
      return Uint8Array.from([...prefix, ...encodeSignedInt64Ascending(BigInt(epochMs))]);
    }
    case 'string':
      if (typeof value.value !== 'string') throw new Error('Indexed string does not match its scalar kind.');
      return Uint8Array.from([...prefix, ...encodeIndexedString(value.value)]);
  }
}

function encodeIndexFields(fields: readonly PluginCollectionIndexScalarV1[]): Uint8Array {
  if (fields.length > 4) throw new Error('An index contains at most four scalar fields.');
  const chunks = fields.map((field) => {
    const encoded = encodeIndexedScalar(field);
    if (field.direction !== 'desc') return encoded;
    return Uint8Array.from(encoded, (byte) => 0xff - byte);
  });
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Canonical raw-byte ascending prefix encoding for a static collection index.
 * Query adapters use it only for admitted equality/range bounds; caller input
 * never selects an index or encoding format.
 */
export function encodePluginCollectionIndexTuplePrefixV1(input: Readonly<{
  fields: readonly PluginCollectionIndexScalarV1[];
}>): Uint8Array {
  const encoded = encodeIndexFields(input.fields);
  if (encoded.byteLength > MAX_COLLECTION_INDEX_TUPLE_PREFIX_BYTES) {
    throw new Error('Encoded collection index prefix exceeds the 2,060-byte limit.');
  }
  return encoded;
}

/** The final row-ID tie-breaker makes all stored collection index entries total. */
export function encodePluginCollectionIndexSortKeyV1(input: Readonly<{
  fields: readonly PluginCollectionIndexScalarV1[];
  rowId: string;
}>): Uint8Array {
  const rowId = PluginCollectionRowIdV1Schema.parse(input.rowId);
  const fields = encodeIndexFields(input.fields);
  const tieBreaker = encodeIndexedString(rowId);
  const encoded = new Uint8Array(fields.byteLength + tieBreaker.byteLength);
  encoded.set(fields);
  encoded.set(tieBreaker, fields.byteLength);
  if (encoded.byteLength > PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1) {
    throw new Error('Encoded collection index sort key exceeds the 2,318-byte limit.');
  }
  return encoded;
}

/** Compares canonical raw sort-key bytes using their portable ordinal order. */
export function comparePluginCollectionIndexSortKeysV1(left: Uint8Array, right: Uint8Array): number {
  const sharedLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

/** Returns the exclusive upper bound for every key with the supplied byte prefix. */
export function nextPluginCollectionIndexPrefixV1(encodedPrefix: Uint8Array): Uint8Array | null {
  for (let index = encodedPrefix.length - 1; index >= 0; index -= 1) {
    if (encodedPrefix[index]! === 0xff) continue;
    const next = encodedPrefix.slice(0, index + 1);
    next[index] = next[index]! + 1;
    return next;
  }
  return null;
}

/**
 * Realm adapters use the admitted descriptor to ensure a response cannot add,
 * omit, or change the scalar type of the server-readable projection.
 */
export function validatePluginCollectionUiQueryResultV1(
  descriptor: NormalizedPluginCollectionUiQueryDescriptorV1,
  result: PluginCollectionUiQueryResultV1,
): PluginCollectionUiQueryResultV1 {
  const parsed = PluginCollectionUiQueryResultV1Schema.parse(result);
  const expectedFields = new Map(descriptor.projectedFields.map((field) => [field.field, field.kind]));
  for (const row of parsed.rows) {
    if (
      row.context.collection.pluginId !== descriptor.collection.pluginId
      || row.context.collection.collectionId !== descriptor.collection.collectionId
    ) {
      throw new Error('UI query result contains a row for a different collection.');
    }
    for (const field of Object.keys(row.fields)) {
      if (!expectedFields.has(field)) {
        throw new Error(`UI query result contains undeclared field "${field}".`);
      }
    }
    for (const [field, kind] of expectedFields) {
      if (!(field in row.fields)) {
        throw new Error(`UI query result omits declared field "${field}".`);
      }
      const value = row.fields[field];
      if (value === null) continue;
      const valid = kind === 'string'
        ? typeof value === 'string'
        : kind === 'finiteNumber'
          ? typeof value === 'number' && Number.isFinite(value)
          : kind === 'boolean'
            ? typeof value === 'boolean'
            : typeof value === 'string' && isCanonicalPluginCollectionIndexedInstantV1(value);
      if (!valid) {
        throw new Error(`UI query result field "${field}" does not match its declared scalar kind.`);
      }
    }
  }
  return parsed;
}
