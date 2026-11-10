import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import {
  isAccountScopedBlobCiphertextForKind,
} from '../../crypto/accountScopedCipher.js';
import type { JsonValue } from '../../json/strictJsonValue.js';
import { PluginSettingFieldIdV2Schema } from '../contributions/settings.js';
import { PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1 } from './accountSettingsLimits.js';

export { PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1 } from './accountSettingsLimits.js';

const textEncoder = new TextEncoder();

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (!isJsonRecord(value)) {
    throw new Error('Plugin Account Settings values must be strict JSON');
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`
  )).join(',')}}`;
}

function normalizeJsonValue(value: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  if (depth > PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumJsonDepth) {
    throw new Error('Plugin Account Settings JSON depth limit exceeded');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Plugin Account Settings numbers must be finite');
    return value;
  }
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') {
    throw new Error('Plugin Account Settings values must be strict JSON');
  }
  if (seen.has(value)) throw new Error('Plugin Account Settings values cannot contain cycles');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new Error('Plugin Account Settings arrays cannot contain symbols');
        if (key === 'length') continue;
        if (!/^(0|[1-9]\d*)$/u.test(key)) {
          throw new Error('Plugin Account Settings arrays cannot have named properties');
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error('Plugin Account Settings arrays cannot be sparse');
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) {
          throw new Error('Plugin Account Settings values cannot contain accessors');
        }
        output.push(normalizeJsonValue(descriptor.value, depth + 1, seen));
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Plugin Account Settings objects must have a plain or null prototype');
    }
    const output = Object.create(null) as Record<string, JsonValue>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error('Plugin Account Settings objects cannot contain symbols');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('Plugin Account Settings values cannot contain accessors');
      }
      output[key] = normalizeJsonValue(descriptor.value, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function addIssue(context: z.core.ParsePayload | z.core.$RefinementCtx, message: string, path?: (string | number)[]): void {
  ('addIssue' in context ? context.addIssue({
    code: "custom",
    message,
    ...(path ? { path } : {}),
  }) : context.issues.push({
    code: "custom",
    message,
    ...(path ? { path } : {}), input: context.value }));
}

const PluginAccountSettingsValuesV1RawSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  values: z.record(PluginSettingFieldIdV2Schema, z.unknown()),
}));

/**
 * The persisted payload carries values only. The reserved UserKV row version
 * is the single Account Settings CAS revision and is never duplicated here.
 */
export const PluginAccountSettingsValuesV1Schema = lazyZodSchema(() => z.pipe(PluginAccountSettingsValuesV1RawSchema, z.transform((input, context) => {
  const entries = Object.entries(input.values);
  if (entries.length > PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumFields) {
    addIssue(context, `Plugin Account Settings may contain at most ${PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumFields} fields`, ['values']);
    return z.NEVER;
  }
  const values = Object.create(null) as Record<string, JsonValue>;
  try {
    for (const [id, value] of entries) {
      const normalized = normalizeJsonValue(value, 0, new WeakSet<object>());
      if (textEncoder.encode(canonicalJson(normalized)).byteLength > PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumFieldEncodedBytes) {
        addIssue(context, `Plugin Account Settings field '${id}' exceeds the encoded byte limit`, ['values', id]);
        return z.NEVER;
      }
      values[id] = normalized;
    }
    const output = Object.freeze({ v: 1 as const, values: Object.freeze(values) });
    if (textEncoder.encode(canonicalJson(output as JsonValue)).byteLength > PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumRecordEncodedBytes) {
      addIssue(context, 'Plugin Account Settings record exceeds the encoded byte limit');
      return z.NEVER;
    }
    return output;
  } catch (error) {
    addIssue(context, error instanceof Error ? error.message : 'Plugin Account Settings value is invalid', ['values']);
    return z.NEVER;
  }
})));
export type PluginAccountSettingsValuesV1 = z.infer<typeof PluginAccountSettingsValuesV1Schema>;
export const PluginAccountSettingsValuesV1StoredSchema = createStoredReadSchema(PluginAccountSettingsValuesV1Schema);

const PluginAccountSettingsEncryptedCiphertextWriteV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.superRefine((ciphertext, context) => {
    if (
      textEncoder.encode(ciphertext).byteLength
      > PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumEncryptedCiphertextUtf8Bytes
    ) {
      addIssue(
        context,
        'Plugin Account Settings encrypted ciphertext exceeds the maximum encoded record size',
        ['c'],
      );
    }
  })));

/** Server storage is envelope-only: it never opens or interprets E2EE values. */
export const PluginAccountSettingsContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('plain'),
    v: PluginAccountSettingsValuesV1Schema,
  }),
  z.strictObject({
    t: z.literal('encrypted'),
    c: z.string().check(z.minLength(1)),
  }),
]));
export type PluginAccountSettingsContentV1 = z.infer<typeof PluginAccountSettingsContentV1Schema>;
export const PluginAccountSettingsContentV1StoredSchema = createStoredReadSchema(PluginAccountSettingsContentV1Schema);

/**
 * Current writers use the cipher-derived bound while the broad reader above
 * preserves an oversized predecessor envelope for recovery.
 */
const PluginAccountSettingsContentV1WriteSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('plain'),
    v: PluginAccountSettingsValuesV1Schema,
  }),
  z.strictObject({
    t: z.literal('encrypted'),
    c: PluginAccountSettingsEncryptedCiphertextWriteV1Schema,
  }),
]));

/**
 * Declarative Settings has its own Account-scoped cipher domain. It remains
 * distinct from Account KV, Collections, and the host Account settings root.
 */
export const PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1 =
  'plugin_declarative_settings' as const;

export class PluginAccountSettingsContentModeMismatchError extends Error {
  constructor() {
    super('Plugin Account Settings content does not match the Account encryption mode');
    this.name = 'PluginAccountSettingsContentModeMismatchError';
  }
}

/**
 * Checks the Account mode and, for opaque E2EE content, its exact cipher
 * purpose before a caller can disclose or persist the envelope.
 */
export function assertPluginAccountSettingsContentForModeV1(
  input: unknown,
  mode: 'plain' | 'e2ee',
): PluginAccountSettingsContentV1 {
  const content = PluginAccountSettingsContentV1Schema.parse(input);
  if (
    (mode === 'plain' && content.t !== 'plain')
    || (
      mode === 'e2ee'
      && (
        content.t !== 'encrypted'
        || !isAccountScopedBlobCiphertextForKind({
          kind: PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
          ciphertext: content.c,
        })
      )
    )
  ) {
    throw new PluginAccountSettingsContentModeMismatchError();
  }
  return content;
}

const PluginAccountSettingsRevisionV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));

export const PluginAccountSettingsReadResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('present'),
    revision: PluginAccountSettingsRevisionV1Schema,
    content: PluginAccountSettingsContentV1StoredSchema,
  }),
  z.strictObject({ status: z.literal('absent') }),
  z.strictObject({
    status: z.literal('deleted'),
    revision: PluginAccountSettingsRevisionV1Schema,
  }),
]));
export type PluginAccountSettingsReadResponseV1 = z.infer<typeof PluginAccountSettingsReadResponseV1Schema>;

export const PluginAccountSettingsMutationRequestV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.union([
    PluginAccountSettingsRevisionV1Schema,
    z.literal('absent'),
  ]),
  content: z.nullable(PluginAccountSettingsContentV1WriteSchema),
}));
export type PluginAccountSettingsMutationRequestV1 = z.infer<typeof PluginAccountSettingsMutationRequestV1Schema>;

export const PluginAccountSettingsMutationResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('updated'),
    revision: PluginAccountSettingsRevisionV1Schema,
  }),
  z.strictObject({
    status: z.literal('conflict'),
    revision: PluginAccountSettingsRevisionV1Schema,
  }),
]));
export type PluginAccountSettingsMutationResponseV1 = z.infer<typeof PluginAccountSettingsMutationResponseV1Schema>;

export const PluginAccountSettingsStorageUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal('plugin_account_settings_storage_unavailable'),
}));
