import { z } from 'zod';

import { cloneStrictPluginJsonValue } from '../plugins/contributions/strictJsonValue.js';

/**
 * The one Protocol-owned strict JSON value: data that has already passed
 * `normalizeStrictJsonValue`, so it carries the prototype, accessor,
 * dense-array, finite-number, and immutable-snapshot guarantees that owner
 * enforces. Strict JSON preserves lone UTF-16 surrogates for `JSON.stringify`;
 * raw UTF-8 and aggregate-byte requirements belong to their named boundary
 * owners. Every other strict
 * spelling in this repository is an alias of this type (`ProtocolJsonValue`)
 * or a declaration-neutral SDK projection of it; the mutable
 * pre-normalization vocabulary is `PluginJsonValueV2` in
 * `plugins/contributions/jsonSchema.ts`.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function normalizeStrictJsonValue(input: unknown): JsonValue {
  return cloneStrictPluginJsonValue(input, 'value') as JsonValue;
}

export const StrictJsonValueSchema = z.unknown().transform((value, context): JsonValue => {
  try {
    return normalizeStrictJsonValue(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid strict JSON value',
    });
    return z.NEVER;
  }
});
