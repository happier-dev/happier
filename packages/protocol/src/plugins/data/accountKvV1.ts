import { z } from 'zod';

import {
  getAccountScopedBlobCiphertextBase64LengthV1,
  isAccountScopedBlobCiphertextForKind,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../../crypto/accountScopedCipher.js';
import {
  normalizeStrictJsonValue,
  type JsonValue,
} from '../../json/strictJsonValue.js';
import {
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../contributions/strictJsonValue.js';

const PLUGIN_ACCOUNT_STORAGE_MAXIMUM_ROW_ENCODED_BYTES_V1 = 512 * 1024;

export const PLUGIN_ACCOUNT_STORAGE_LIMITS_V1 = Object.freeze({
  maximumLogicalKeys: 256,
  maximumLogicalKeyUtf8Bytes: 256,
  maximumValueEncodedBytes: 64 * 1024,
  maximumRowEncodedBytes: PLUGIN_ACCOUNT_STORAGE_MAXIMUM_ROW_ENCODED_BYTES_V1,
  maximumEncryptedCiphertextUtf8Bytes: getAccountScopedBlobCiphertextBase64LengthV1(
    PLUGIN_ACCOUNT_STORAGE_MAXIMUM_ROW_ENCODED_BYTES_V1,
  ),
} as const);

const textEncoder = new TextEncoder();
const RESERVED_LOGICAL_KEY_PREFIX = '@happier/' as const;

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function addCustomIssue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, message });
}

/**
 * Account KV shares Protocol's one strict-JSON grammar. Its only additional
 * value rule is the Data-owned complete serialized-byte ceiling.
 */
export function normalizePluginAccountStorageJsonValueV1(input: unknown): JsonValue {
  const normalized = normalizeStrictJsonValue(input);
  if (
    measureSerializedValidatedStrictPluginJsonUtf8Bytes(
      normalized,
      'Plugin Account KV value',
      PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumValueEncodedBytes,
    ) > PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumValueEncodedBytes
  ) {
    throw new Error('Plugin Account KV value byte limit exceeded');
  }
  return normalized;
}

export const PluginAccountStorageJsonValueV1Schema = z.unknown().transform((value, context): JsonValue => {
  try {
    return normalizePluginAccountStorageJsonValueV1(value);
  } catch (error) {
    addCustomIssue(
      context,
      error instanceof Error ? error.message : 'Invalid Plugin Account KV JSON value',
    );
    return z.NEVER;
  }
});
export type PluginAccountStorageJsonValueV1 = z.infer<typeof PluginAccountStorageJsonValueV1Schema>;

export const PluginAccountStorageLogicalKeyV1Schema = z.string().min(1).superRefine((key, context) => {
  if (key.startsWith(RESERVED_LOGICAL_KEY_PREFIX)) {
    addCustomIssue(context, 'Plugin Account KV logical keys cannot use the @happier/ namespace');
  }
  if (utf8ByteLength(key) > PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumLogicalKeyUtf8Bytes) {
    addCustomIssue(context, 'Plugin Account KV logical keys must be at most 256 UTF-8 bytes');
  }
});
export type PluginAccountStorageLogicalKeyV1 = z.infer<typeof PluginAccountStorageLogicalKeyV1Schema>;

export const PluginAccountStorageValueEntryV1Schema = z.object({
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  value: PluginAccountStorageJsonValueV1Schema,
}).strict();
export type PluginAccountStorageValueEntryV1 = z.infer<typeof PluginAccountStorageValueEntryV1Schema>;

/** A retained logical-key deletion is an identity/version, never absence. */
export const PluginAccountStorageDeletedEntryV1Schema = z.object({
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  deleted: z.literal(true),
}).strict();
export type PluginAccountStorageDeletedEntryV1 = z.infer<typeof PluginAccountStorageDeletedEntryV1Schema>;

export const PluginAccountStorageEntryV1Schema = z.union([
  PluginAccountStorageValueEntryV1Schema,
  PluginAccountStorageDeletedEntryV1Schema,
]);
export type PluginAccountStorageEntryV1 = z.infer<typeof PluginAccountStorageEntryV1Schema>;

export const PluginAccountStorageRowV1Schema = z.object({
  v: z.literal(1),
  values: z.record(
    PluginAccountStorageLogicalKeyV1Schema,
    PluginAccountStorageEntryV1Schema,
  ),
}).strict().superRefine((row, context) => {
  const entries = Object.entries(row.values);
  if (entries.length > PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumLogicalKeys) {
    addCustomIssue(context, 'Plugin Account KV rows may contain at most 256 logical keys');
  }
  if (
    measureSerializedValidatedStrictPluginJsonUtf8Bytes(
      normalizeStrictJsonValue(row),
      'Plugin Account KV row',
      PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumRowEncodedBytes,
    ) > PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumRowEncodedBytes
  ) {
    addCustomIssue(context, 'Plugin Account KV row byte limit exceeded');
  }
});
export type PluginAccountStorageRowV1 = z.infer<typeof PluginAccountStorageRowV1Schema>;

const PluginAccountStorageEncryptedCiphertextV1Schema = z.string().min(1).superRefine(
  (ciphertext, context) => {
    if (
      utf8ByteLength(ciphertext)
      > PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumEncryptedCiphertextUtf8Bytes
    ) {
      addCustomIssue(
        context,
        'Plugin Account KV encrypted ciphertext exceeds the maximum encoded row size',
      );
    }
  },
);

/**
 * The encrypted Account-KV row is its own Account-scoped cipher domain. It
 * is intentionally distinct from Collection and declarative Settings payloads
 * so the server's envelope check cannot accept a cross-domain ciphertext.
 */
export const PLUGIN_ACCOUNT_STORAGE_PRIVATE_PAYLOAD_ACCOUNT_SCOPED_BLOB_KIND_V1 =
  'plugin_account_kv_private_payload' as const;

export function sealPluginAccountStoragePrivatePayloadV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  payload: PluginAccountStorageRowV1;
  randomBytes: (length: number) => Uint8Array;
}>): string {
  return sealAccountScopedBlobCiphertext({
    kind: PLUGIN_ACCOUNT_STORAGE_PRIVATE_PAYLOAD_ACCOUNT_SCOPED_BLOB_KIND_V1,
    material: params.material,
    payload: PluginAccountStorageRowV1Schema.parse(params.payload),
    randomBytes: params.randomBytes,
  });
}

/** Opens and validates only an exact Account-KV ciphertext domain. */
export function openPluginAccountStoragePrivatePayloadV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  ciphertext: string;
}>): PluginAccountStorageRowV1 | null {
  const opened = openAccountScopedBlobCiphertext({
    kind: PLUGIN_ACCOUNT_STORAGE_PRIVATE_PAYLOAD_ACCOUNT_SCOPED_BLOB_KIND_V1,
    material: params.material,
    ciphertext: params.ciphertext,
  });
  if (!opened) return null;
  const parsed = PluginAccountStorageRowV1Schema.safeParse(opened.value);
  return parsed.success ? parsed.data : null;
}

/**
 * The row is opaque to the server in E2EE mode, but its representation is
 * explicit and mode-checked before read or mutation. A plaintext account
 * never needs an Account content key just to read this envelope.
 */
export const PluginAccountStorageEnvelopeV1Schema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: PluginAccountStorageRowV1Schema,
  }).strict(),
  z.object({
    t: z.literal('encrypted'),
    c: PluginAccountStorageEncryptedCiphertextV1Schema,
  }).strict(),
]);
export type PluginAccountStorageEnvelopeV1 = z.infer<typeof PluginAccountStorageEnvelopeV1Schema>;

export class PluginAccountStorageEnvelopeModeMismatchError extends Error {
  constructor() {
    super('Plugin Account KV envelope does not match the Account encryption mode');
    this.name = 'PluginAccountStorageEnvelopeModeMismatchError';
  }
}

export function assertPluginAccountStorageEnvelopeForModeV1(
  input: unknown,
  mode: 'plain' | 'e2ee',
): PluginAccountStorageEnvelopeV1 {
  const envelope = PluginAccountStorageEnvelopeV1Schema.parse(input);
  if (
    (mode === 'plain' && envelope.t !== 'plain')
    || (
      mode === 'e2ee'
      && (
        envelope.t !== 'encrypted'
        || !isAccountScopedBlobCiphertextForKind({
          kind: PLUGIN_ACCOUNT_STORAGE_PRIVATE_PAYLOAD_ACCOUNT_SCOPED_BLOB_KIND_V1,
          ciphertext: envelope.c,
        })
      )
    )
  ) {
    throw new PluginAccountStorageEnvelopeModeMismatchError();
  }
  return envelope;
}

const PluginAccountStorageRevisionV1Schema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

/**
 * Transport shapes deliberately move only the one opaque Account row. The
 * bound SDK adapter owns logical-key operations and never exposes physical
 * UserKV identity or uses server-side callbacks for a transaction retry.
 */
export const PluginAccountStorageReadResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('present'),
    revision: PluginAccountStorageRevisionV1Schema,
    content: PluginAccountStorageEnvelopeV1Schema,
  }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
  z.object({
    status: z.literal('deleted'),
    revision: PluginAccountStorageRevisionV1Schema,
  }).strict(),
]);
export type PluginAccountStorageReadResponseV1 = z.infer<
  typeof PluginAccountStorageReadResponseV1Schema
>;

export const PluginAccountStorageMutationRequestV1Schema = z.object({
  expectedRevision: z.union([
    PluginAccountStorageRevisionV1Schema,
    z.literal('absent'),
  ]),
  content: PluginAccountStorageEnvelopeV1Schema.nullable(),
}).strict();
export type PluginAccountStorageMutationRequestV1 = z.infer<
  typeof PluginAccountStorageMutationRequestV1Schema
>;

export const PluginAccountStorageMutationResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('updated'),
    revision: PluginAccountStorageRevisionV1Schema,
  }).strict(),
  z.object({
    status: z.literal('conflict'),
    revision: PluginAccountStorageRevisionV1Schema,
  }).strict(),
]);
export type PluginAccountStorageMutationResponseV1 = z.infer<
  typeof PluginAccountStorageMutationResponseV1Schema
>;

/** Typed failure for an old server, incompatible Account mode, or unavailable key material. */
export const PluginAccountStorageUnavailableV1Schema = z.object({
  error: z.literal('plugin_account_storage_unavailable'),
}).strict();
