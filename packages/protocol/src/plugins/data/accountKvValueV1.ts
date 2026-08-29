import { z } from 'zod';

import {
  normalizeStrictJsonValue,
  type JsonValue,
} from '../../json/strictJsonValue.js';
import {
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../contributions/strictJsonValue.js';

export const PLUGIN_ACCOUNT_STORAGE_BROWSER_NEUTRAL_LIMITS_V1 = Object.freeze({
  maximumLogicalKeys: 256,
  maximumLogicalKeyUtf8Bytes: 256,
  maximumValueEncodedBytes: 64 * 1024,
  maximumRowEncodedBytes: 512 * 1024,
} as const);

const textEncoder = new TextEncoder();
const RESERVED_LOGICAL_KEY_PREFIX = '@happier/' as const;

export function pluginAccountStorageUtf8ByteLengthV1(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function addPluginAccountStorageCustomIssueV1(context: z.RefinementCtx, message: string): void {
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
      PLUGIN_ACCOUNT_STORAGE_BROWSER_NEUTRAL_LIMITS_V1.maximumValueEncodedBytes,
    ) > PLUGIN_ACCOUNT_STORAGE_BROWSER_NEUTRAL_LIMITS_V1.maximumValueEncodedBytes
  ) {
    throw new Error('Plugin Account KV value byte limit exceeded');
  }
  return normalized;
}

export const PluginAccountStorageJsonValueV1Schema = z.unknown().transform((value, context): JsonValue => {
  try {
    return normalizePluginAccountStorageJsonValueV1(value);
  } catch (error) {
    addPluginAccountStorageCustomIssueV1(
      context,
      error instanceof Error ? error.message : 'Invalid Plugin Account KV JSON value',
    );
    return z.NEVER;
  }
});
export type PluginAccountStorageJsonValueV1 = z.infer<typeof PluginAccountStorageJsonValueV1Schema>;

export const PluginAccountStorageLogicalKeyV1Schema = z.string().min(1).superRefine((key, context) => {
  if (key.startsWith(RESERVED_LOGICAL_KEY_PREFIX)) {
    addPluginAccountStorageCustomIssueV1(context, 'Plugin Account KV logical keys cannot use the @happier/ namespace');
  }
  if (pluginAccountStorageUtf8ByteLengthV1(key) > PLUGIN_ACCOUNT_STORAGE_BROWSER_NEUTRAL_LIMITS_V1.maximumLogicalKeyUtf8Bytes) {
    addPluginAccountStorageCustomIssueV1(context, 'Plugin Account KV logical keys must be at most 256 UTF-8 bytes');
  }
});
export type PluginAccountStorageLogicalKeyV1 = z.infer<typeof PluginAccountStorageLogicalKeyV1Schema>;
