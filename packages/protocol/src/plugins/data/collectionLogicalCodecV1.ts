/**
 * The one transport-neutral logical row codec for Account Collections.
 *
 * A collection value is authored as a single logical object, but it crosses the
 * wire in two pieces: the declared server-readable fields travel as a plaintext
 * projection the server can index, and everything else travels inside the
 * Account content envelope. Splitting a logical value into those pieces and
 * reconstructing it again is one contract, so it lives here beside
 * `collectionsV1.ts` rather than being restated by each realm client. Every
 * realm adapter keeps its own lifecycle — Account scope, credentials, watch
 * admission, transport — and maps these protocol-neutral outcomes into its own
 * availability or error model.
 *
 * The codec is pure: it holds no transport, cache, or Account state, and it
 * takes the caller's already-compiled logical-schema validator rather than
 * pulling a JSON Schema compiler into this module graph.
 */
import type { JsonValue } from '../../json/strictJsonValue.js';
import type { AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import {
  PluginCollectionContentEnvelopeV1Schema,
  PluginCollectionPrivatePayloadV1Schema,
  PluginCollectionProjectionV1Schema,
  PluginCollectionRowIdV1Schema,
  PluginCollectionMutationOperationV1Schema,
  PluginCollectionMutationRequestV1Schema,
  assertPluginCollectionContentEnvelopeForModeV1,
  measurePluginCollectionMutationRequestDecompositionV1,
  measurePluginCollectionMutationRequestEncodedBytesV1,
  openPluginCollectionPrivatePayloadV1,
  sealPluginCollectionPrivatePayloadV1,
  type NormalizedPluginAccountCollectionContractV1,
  type PluginCollectionContentEnvelopeV1,
  type PluginCollectionMutationOperationV1,
  type PluginCollectionMutationRequestMeasurementV1,
  type PluginCollectionMutationRequestV1,
  type PluginCollectionProjectionV1,
  type PluginCollectionRowV1,
} from './collectionsV1.js';

/** One collection row as the plugin authored it, before the wire split. */
export type PluginCollectionLogicalValueV1 = Readonly<Record<string, JsonValue>>;

/**
 * The caller's compiled logical-schema check, narrowing to the realm's own
 * value type. Compiling the admitted contract schema stays with the caller so
 * this owner never depends on a JSON Schema compiler.
 */
export type PluginCollectionLogicalValueValidatorV1<
  TValue extends PluginCollectionLogicalValueV1 = PluginCollectionLogicalValueV1,
> = (value: PluginCollectionLogicalValueV1) => value is TValue;

export type PluginCollectionLogicalEncodeFailureReasonV1 =
  /** The authored value does not satisfy the collection's admitted schema. */
  | 'value-schema-invalid'
  /** The row-id field is missing or is not a valid row identity. */
  | 'row-identity-invalid'
  /** The derived server-readable projection is not a valid wire projection. */
  | 'projection-invalid'
  /** The remaining fields are not a valid private payload, or sealing failed. */
  | 'private-payload-invalid'
  /** An E2EE Account was named without the Account-scoped material to seal with. */
  | 'encryption-material-unavailable';

export type PluginCollectionLogicalEncodeOutcomeV1 =
  | Readonly<{
    status: 'encoded';
    rowId: string;
    content: PluginCollectionContentEnvelopeV1;
    projection: PluginCollectionProjectionV1;
  }>
  | Readonly<{ status: 'failed'; reason: PluginCollectionLogicalEncodeFailureReasonV1 }>;

export type PluginCollectionLogicalMutationV1<
  TValue extends PluginCollectionLogicalValueV1 = PluginCollectionLogicalValueV1,
> =
  | Readonly<{ kind: 'put'; value: TValue; expectedRevision: number | 'absent' }>
  | Readonly<{ kind: 'delete' | 'assert'; rowId: string; expectedRevision: number }>;

export type PluginCollectionLogicalMutationRequestOutcomeV1 =
  | Readonly<{
    status: 'prepared';
    request: PluginCollectionMutationRequestV1;
    encodedBytes: number;
    measurement: PluginCollectionMutationRequestMeasurementV1;
  }>
  | Readonly<{
    status: 'failed';
    reason: PluginCollectionLogicalEncodeFailureReasonV1 | 'mutation-request-invalid';
  }>;

export type PluginCollectionLogicalDecodeFailureReasonV1 =
  /** The stored envelope does not match the Account's current encryption mode. */
  | 'content-mode-mismatch'
  /** The row's projection is not the contract's exact server-readable set. */
  | 'projection-mismatch'
  /** The private payload carries a field the projection already owns. */
  | 'private-payload-overlaps-projection'
  /** The reconstructed logical row does not satisfy the admitted schema. */
  | 'row-schema-invalid';

export type PluginCollectionLogicalDecodeOutcomeV1<
  TValue extends PluginCollectionLogicalValueV1 = PluginCollectionLogicalValueV1,
> =
  | Readonly<{ status: 'decoded'; rowId: string; revision: number; value: TValue }>
  | Readonly<{ status: 'failed'; reason: PluginCollectionLogicalDecodeFailureReasonV1 }>;

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Rows are assembled field by field into a null-prototype record whose members
 * cannot be redefined afterwards, so neither a projection field nor a private
 * field can be shadowed by a later write or by an inherited member during
 * reconstruction. Strict JSON admits both a null and an `Object.prototype`
 * prototype; the null one is used because it is also what Protocol's own strict
 * normalizer produces.
 */
function createJsonRecord(): Record<string, JsonValue> {
  return Object.create(null) as Record<string, JsonValue>;
}

function setJsonRecordValue(
  record: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

/**
 * The wire projection must be exactly the contract's admitted server-readable
 * set — no extra field, no omitted field — and its row-identity member must
 * agree with the row's own address.
 */
function isExactProjection(input: Readonly<{
  contract: NormalizedPluginAccountCollectionContractV1;
  rowId: string;
  projection: PluginCollectionProjectionV1;
}>): boolean {
  const fields = Object.keys(input.projection);
  const expected = new Set(input.contract.serverReadable);
  if (fields.length !== expected.size || fields.some((field) => !expected.has(field))) return false;
  for (const field of input.contract.serverReadable) {
    if (!hasOwn(input.projection, field)) return false;
    if (field === input.contract.rowIdField && input.projection[field] !== input.rowId) return false;
  }
  return true;
}

/**
 * Splits one authored logical value into the exact wire projection and the
 * mode-appropriate private content envelope.
 *
 * An admitted server-readable field is always a declared non-nullable scalar,
 * so `null` is unambiguously this transport's spelling for "this optional field
 * is absent". Writing that sentinel here is what
 * `decodePluginCollectionLogicalRowV1` reverses.
 */
export function encodePluginCollectionLogicalValueV1(input: Readonly<{
  contract: NormalizedPluginAccountCollectionContractV1;
  isValidLogicalValue: (value: PluginCollectionLogicalValueV1) => boolean;
  value: PluginCollectionLogicalValueV1;
  encryptionMode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial | null;
  randomBytes: (length: number) => Uint8Array;
}>): PluginCollectionLogicalEncodeOutcomeV1 {
  if (!input.isValidLogicalValue(input.value)) {
    return { status: 'failed', reason: 'value-schema-invalid' };
  }
  const rowId = PluginCollectionRowIdV1Schema.safeParse(input.value[input.contract.rowIdField]);
  if (!rowId.success) return { status: 'failed', reason: 'row-identity-invalid' };

  const projection = createJsonRecord();
  for (const field of input.contract.serverReadable) {
    setJsonRecordValue(projection, field, hasOwn(input.value, field) ? input.value[field]! : null);
  }
  const parsedProjection = PluginCollectionProjectionV1Schema.safeParse(projection);
  if (
    !parsedProjection.success
    || !isExactProjection({
      contract: input.contract,
      rowId: rowId.data,
      projection: parsedProjection.data,
    })
  ) {
    return { status: 'failed', reason: 'projection-invalid' };
  }

  const privatePayload = createJsonRecord();
  const reserved = new Set([input.contract.rowIdField, ...input.contract.serverReadable]);
  for (const [field, value] of Object.entries(input.value)) {
    if (!reserved.has(field)) setJsonRecordValue(privatePayload, field, value);
  }
  const material = input.material;
  if (input.encryptionMode === 'e2ee' && !material) {
    return { status: 'failed', reason: 'encryption-material-unavailable' };
  }
  try {
    const content = material && input.encryptionMode === 'e2ee'
      ? PluginCollectionContentEnvelopeV1Schema.parse({
        t: 'encrypted',
        c: sealPluginCollectionPrivatePayloadV1({
          material,
          payload: PluginCollectionPrivatePayloadV1Schema.parse(privatePayload),
          randomBytes: input.randomBytes,
        }),
      })
      : PluginCollectionContentEnvelopeV1Schema.parse({ t: 'plain', v: privatePayload });
    return {
      status: 'encoded',
      rowId: rowId.data,
      content,
      projection: parsedProjection.data,
    };
  } catch {
    return { status: 'failed', reason: 'private-payload-invalid' };
  }
}

/**
 * Prepares one closed wire mutation request from transport-neutral logical
 * operations and measures the exact bytes that request will carry. Realm
 * adapters supply lifecycle-bound crypto inputs, then map this typed outcome
 * into their own availability/error vocabulary.
 */
export function preparePluginCollectionLogicalMutationRequestV1<
  TValue extends PluginCollectionLogicalValueV1 = PluginCollectionLogicalValueV1,
>(input: Readonly<{
  contract: NormalizedPluginAccountCollectionContractV1;
  isValidLogicalValue: PluginCollectionLogicalValueValidatorV1<TValue>;
  operations: readonly PluginCollectionLogicalMutationV1<TValue>[];
  encryptionMode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial | null;
  randomBytes: (length: number) => Uint8Array;
}>): PluginCollectionLogicalMutationRequestOutcomeV1 {
  const operations: PluginCollectionMutationOperationV1[] = [];
  for (const operation of input.operations) {
    if (operation.kind !== 'put') {
      const parsed = PluginCollectionMutationOperationV1Schema.safeParse(operation);
      if (!parsed.success || parsed.data.kind === 'put') {
        return { status: 'failed', reason: 'mutation-request-invalid' };
      }
      operations.push(parsed.data);
      continue;
    }
    const encoded = encodePluginCollectionLogicalValueV1({
      contract: input.contract,
      isValidLogicalValue: input.isValidLogicalValue,
      value: operation.value,
      encryptionMode: input.encryptionMode,
      material: input.material,
      randomBytes: input.randomBytes,
    });
    if (encoded.status === 'failed') return encoded;
    operations.push({
      kind: 'put',
      rowId: encoded.rowId,
      expectedRevision: operation.expectedRevision,
      content: encoded.content,
      projection: encoded.projection,
    });
  }
  const request = PluginCollectionMutationRequestV1Schema.safeParse({
    pluginId: input.contract.pluginId,
    collectionId: input.contract.collectionId,
    writerContext: {
      schemaVersion: input.contract.schemaVersion,
      contractDigest: input.contract.contractDigest,
    },
    operations,
  });
  if (!request.success) return { status: 'failed', reason: 'mutation-request-invalid' };
  return Object.freeze({
    status: 'prepared',
    request: request.data,
    encodedBytes: measurePluginCollectionMutationRequestEncodedBytesV1(request.data),
    measurement: measurePluginCollectionMutationRequestDecompositionV1(request.data),
  });
}

/**
 * Reconstructs one logical value from a stored row's projection and content
 * envelope.
 *
 * A projected `null` is restored as an absent field, not as an explicit `null`
 * member: a server-readable field's scalar kind is resolved from its declared
 * schema and can never be `null`, so the only value that sentinel can carry is
 * "this optional field was absent when the row was written". Reconstructing it
 * as a literal `null` would fail the admitted schema for an ordinary optional
 * non-nullable field and reject a row the plugin legitimately wrote.
 */
export function decodePluginCollectionLogicalRowV1<
  TValue extends PluginCollectionLogicalValueV1 = PluginCollectionLogicalValueV1,
>(input: Readonly<{
  contract: NormalizedPluginAccountCollectionContractV1;
  isValidLogicalValue: PluginCollectionLogicalValueValidatorV1<TValue>;
  row: PluginCollectionRowV1;
  encryptionMode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial | null;
}>): PluginCollectionLogicalDecodeOutcomeV1<TValue> {
  let privatePayload: Readonly<Record<string, JsonValue>>;
  try {
    const envelope = assertPluginCollectionContentEnvelopeForModeV1(
      input.row.content,
      input.encryptionMode,
    );
    const opened = envelope.t === 'plain'
      ? envelope.v
      : input.material
        ? openPluginCollectionPrivatePayloadV1({
          material: input.material,
          ciphertext: envelope.c,
        })
        : null;
    if (!opened) return { status: 'failed', reason: 'content-mode-mismatch' };
    privatePayload = opened;
  } catch {
    return { status: 'failed', reason: 'content-mode-mismatch' };
  }

  if (!isExactProjection({
    contract: input.contract,
    rowId: input.row.rowId,
    projection: input.row.projection,
  })) {
    return { status: 'failed', reason: 'projection-mismatch' };
  }

  const logical = createJsonRecord();
  const reserved = new Set([input.contract.rowIdField, ...input.contract.serverReadable]);
  for (const [field, value] of Object.entries(privatePayload)) {
    if (reserved.has(field)) {
      return { status: 'failed', reason: 'private-payload-overlaps-projection' };
    }
    setJsonRecordValue(logical, field, value);
  }
  for (const field of input.contract.serverReadable) {
    const value = input.row.projection[field];
    if (value !== null && value !== undefined) setJsonRecordValue(logical, field, value);
  }
  if (!hasOwn(logical, input.contract.rowIdField)) {
    setJsonRecordValue(logical, input.contract.rowIdField, input.row.rowId);
  }
  const value = Object.freeze(logical);
  if (!input.isValidLogicalValue(value)) {
    return { status: 'failed', reason: 'row-schema-invalid' };
  }
  return {
    status: 'decoded',
    rowId: input.row.rowId,
    revision: input.row.revision,
    value,
  };
}
