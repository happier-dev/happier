import { z } from 'zod';

import {
  getAccountScopedBlobCiphertextBase64LengthV1,
  isAccountScopedBlobCiphertextForKind,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../../crypto/accountScopedCipher.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import {
  normalizeStrictJsonValue,
  type JsonValue,
} from '../../json/strictJsonValue.js';
import {
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../contributions/strictJsonValue.js';
import {
  PLUGIN_ACCOUNT_STORAGE_BROWSER_NEUTRAL_LIMITS_V1,
  PluginAccountStorageJsonValueV1Schema,
  PluginAccountStorageLogicalKeyV1Schema,
  addPluginAccountStorageCustomIssueV1 as addCustomIssue,
  normalizePluginAccountStorageJsonValueV1,
  pluginAccountStorageUtf8ByteLengthV1 as utf8ByteLength,
  type PluginAccountStorageJsonValueV1,
  type PluginAccountStorageLogicalKeyV1,
} from './accountKvValueV1.js';

export {
  PluginAccountStorageJsonValueV1Schema,
  PluginAccountStorageLogicalKeyV1Schema,
  normalizePluginAccountStorageJsonValueV1,
} from './accountKvValueV1.js';
export type {
  PluginAccountStorageJsonValueV1,
  PluginAccountStorageLogicalKeyV1,
} from './accountKvValueV1.js';

export const PLUGIN_ACCOUNT_STORAGE_LIMITS_V1 = Object.freeze({
  ...PLUGIN_ACCOUNT_STORAGE_BROWSER_NEUTRAL_LIMITS_V1,
  maximumEncryptedCiphertextUtf8Bytes: getAccountScopedBlobCiphertextBase64LengthV1(
    PLUGIN_ACCOUNT_STORAGE_BROWSER_NEUTRAL_LIMITS_V1.maximumRowEncodedBytes,
  ),
} as const);

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

/**
 * The logical-key layer over one opaque Account KV row.
 *
 * Every realm that speaks Account KV — the daemon runtime and the direct
 * Plugin UI client — applies the *same* key normalization, per-key version
 * advance, conditional-write rule, tombstone rule, and list paging. Keeping
 * that algebra here is what makes a second KV implementation unnecessary: a
 * realm owns only its transport, Account currentness, and envelope sealing.
 */
export type PluginAccountKvRowErrorCodeV1 =
  | 'plugin_account_kv_invalid'
  | 'plugin_account_kv_conflict'
  | 'plugin_account_kv_cursor_stale';

export class PluginAccountKvRowError extends Error {
  readonly code: PluginAccountKvRowErrorCodeV1;

  constructor(code: PluginAccountKvRowErrorCodeV1, message: string) {
    super(message);
    this.name = 'PluginAccountKvRowError';
    this.code = code;
  }
}

/** The author-visible projection of one retained key. */
export type PluginAccountKvProjectedEntryV1<TValue extends JsonValue = JsonValue> =
  | Readonly<{ version: number; value: TValue }>
  | Readonly<{ version: number; deleted: true }>;

export type PluginAccountKvProjectedListItemV1 =
  Readonly<{ key: string }> & PluginAccountKvProjectedEntryV1;

const PLUGIN_ACCOUNT_KV_DEFAULT_LIST_LIMIT_V1 = 100;
const PLUGIN_ACCOUNT_KV_MAXIMUM_LIST_LIMIT_V1 = 1_000;
const PLUGIN_ACCOUNT_KV_RESERVED_KEY_PREFIX_V1 = '@happier/';

function hasOwnKey(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizePluginAccountKvValueV1(value: JsonValue): JsonValue {
  try {
    return normalizePluginAccountStorageJsonValueV1(value);
  } catch {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_invalid',
      'Account KV value is not within the published JSON bounds',
    );
  }
}

export function normalizePluginAccountKvLogicalKeyV1(key: string): string {
  const parsed = PluginAccountStorageLogicalKeyV1Schema.safeParse(key);
  if (!parsed.success) {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_invalid',
      'Account KV key is invalid or reserved',
    );
  }
  return parsed.data;
}

export function createEmptyPluginAccountKvRowV1(): PluginAccountStorageRowV1 {
  return PluginAccountStorageRowV1Schema.parse({ v: 1, values: Object.create(null) });
}

export function clonePluginAccountKvRowV1(
  row: PluginAccountStorageRowV1,
): PluginAccountStorageRowV1 {
  return PluginAccountStorageRowV1Schema.parse(row);
}

export function readPluginAccountKvEntryV1(
  row: PluginAccountStorageRowV1,
  key: string,
): PluginAccountStorageEntryV1 | undefined {
  return hasOwnKey(row.values, key) ? row.values[key] : undefined;
}

export function projectPluginAccountKvEntryV1<TValue extends JsonValue = JsonValue>(
  entry: PluginAccountStorageEntryV1,
): PluginAccountKvProjectedEntryV1<TValue> {
  if ('deleted' in entry) {
    return Object.freeze({ version: entry.version, deleted: true as const });
  }
  return Object.freeze({
    version: entry.version,
    value: normalizePluginAccountKvValueV1(entry.value) as TValue,
  });
}

export function projectPluginAccountKvListItemV1(
  key: string,
  entry: PluginAccountStorageEntryV1,
): PluginAccountKvProjectedListItemV1 {
  const projected = projectPluginAccountKvEntryV1(entry);
  return 'deleted' in projected
    ? Object.freeze({ key, version: projected.version, deleted: true as const })
    : Object.freeze({ key, version: projected.version, value: projected.value });
}

/**
 * The one conditional-write rule. A tombstone stays visible with its version so
 * a stale `absent` writer cannot resurrect a key it never observed being deleted.
 */
export function assertPluginAccountKvExpectedVersionV1(
  row: PluginAccountStorageRowV1,
  key: string,
  expectedVersion: number | 'absent',
): PluginAccountStorageEntryV1 | undefined {
  if (
    expectedVersion !== 'absent'
    && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
  ) {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_invalid',
      'Account KV expected version is invalid',
    );
  }
  const current = readPluginAccountKvEntryV1(row, key);
  if (
    (expectedVersion === 'absent' && current !== undefined)
    || (expectedVersion !== 'absent' && (current === undefined || current.version !== expectedVersion))
  ) {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_conflict',
      'Account KV key changed before the conditional write completed',
    );
  }
  return current;
}

function nextPluginAccountKvVersionV1(
  previous: PluginAccountStorageEntryV1 | undefined,
): number {
  if (!previous) return 0;
  if (previous.version >= Number.MAX_SAFE_INTEGER) {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_invalid',
      'Account KV key version cannot advance further',
    );
  }
  return previous.version + 1;
}

export function setPluginAccountKvEntryV1(
  row: PluginAccountStorageRowV1,
  key: string,
  value: JsonValue,
  previous: PluginAccountStorageEntryV1 | undefined,
): number {
  const version = nextPluginAccountKvVersionV1(previous);
  Object.defineProperty(row.values, key, {
    value: Object.freeze({ version, value: normalizePluginAccountKvValueV1(value) }),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return version;
}

export function deletePluginAccountKvEntryV1(
  row: PluginAccountStorageRowV1,
  key: string,
  previous: PluginAccountStorageEntryV1,
): number {
  if ('deleted' in previous) {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_conflict',
      'Account KV key is already deleted',
    );
  }
  const version = nextPluginAccountKvVersionV1(previous);
  Object.defineProperty(row.values, key, {
    value: Object.freeze({ version, deleted: true as const }),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return version;
}

/**
 * The cursor is base64url over the shared Protocol encoder rather than a Node
 * `Buffer`, because the same paging runs in the daemon, the browser and Hermes.
 */
function encodePluginAccountKvListCursorV1(input: Readonly<{
  revision: number;
  prefix: string | null;
  lastKey: string;
}>): string {
  return encodeBase64(
    new TextEncoder().encode(JSON.stringify({
      v: 1,
      revision: input.revision,
      prefix: input.prefix,
      lastKey: input.lastKey,
    })),
    'base64url',
  );
}

function decodePluginAccountKvListCursorV1(cursor: string): Readonly<{
  revision: number;
  prefix: string | null;
  lastKey: string;
}> {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(decodeBase64(cursor, 'base64url')),
    ) as unknown;
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || (parsed as Readonly<Record<string, unknown>>).v !== 1
      || !Number.isSafeInteger((parsed as Readonly<Record<string, unknown>>).revision)
      || (
        (parsed as Readonly<Record<string, unknown>>).prefix !== null
        && typeof (parsed as Readonly<Record<string, unknown>>).prefix !== 'string'
      )
      || typeof (parsed as Readonly<Record<string, unknown>>).lastKey !== 'string'
    ) {
      throw new Error('invalid cursor');
    }
    return Object.freeze({
      revision: (parsed as Readonly<Record<string, unknown>>).revision as number,
      prefix: (parsed as Readonly<Record<string, unknown>>).prefix as string | null,
      lastKey: (parsed as Readonly<Record<string, unknown>>).lastKey as string,
    });
  } catch {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_invalid',
      'Account KV list cursor is invalid',
    );
  }
}

export function listPluginAccountKvEntriesV1(input: Readonly<{
  row: PluginAccountStorageRowV1;
  /** `-1` for an absent row, so a cursor cannot survive the row's first write. */
  revision: number;
  prefix?: string;
  limit?: number;
  cursor?: string;
}>): Readonly<{
  items: readonly PluginAccountKvProjectedListItemV1[];
  nextCursor?: string;
}> {
  if (input.prefix?.startsWith(PLUGIN_ACCOUNT_KV_RESERVED_KEY_PREFIX_V1)) {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_invalid',
      'Account KV key prefix is reserved',
    );
  }
  const limit = input.limit ?? PLUGIN_ACCOUNT_KV_DEFAULT_LIST_LIMIT_V1;
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > PLUGIN_ACCOUNT_KV_MAXIMUM_LIST_LIMIT_V1
  ) {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_invalid',
      'Account KV list limit is invalid',
    );
  }
  const prefix = input.prefix ?? null;
  const cursor = input.cursor === undefined
    ? null
    : decodePluginAccountKvListCursorV1(input.cursor);
  if (cursor && cursor.revision !== input.revision) {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_cursor_stale',
      'Account KV changed before the next page was read',
    );
  }
  if (cursor && cursor.prefix !== prefix) {
    throw new PluginAccountKvRowError(
      'plugin_account_kv_invalid',
      'Account KV list cursor does not match the requested prefix',
    );
  }
  const keys = Object.keys(input.row.values)
    .filter((key) => prefix === null || key.startsWith(prefix))
    .filter((key) => !cursor || key > cursor.lastKey)
    .sort();
  const selected = keys.slice(0, limit);
  const lastKey = selected[selected.length - 1];
  return Object.freeze({
    items: Object.freeze(selected.map((key) => {
      const entry = readPluginAccountKvEntryV1(input.row, key);
      if (!entry) {
        throw new PluginAccountKvRowError(
          'plugin_account_kv_invalid',
          'Account KV list row changed during read',
        );
      }
      return projectPluginAccountKvListItemV1(key, entry);
    })),
    ...(lastKey && keys.length > selected.length
      ? { nextCursor: encodePluginAccountKvListCursorV1({ revision: input.revision, prefix, lastKey }) }
      : {}),
  });
}
