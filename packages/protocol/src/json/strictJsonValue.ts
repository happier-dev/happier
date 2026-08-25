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

/** Compares normalized strict JSON without depending on object insertion order. */
export function sameStrictJsonValue(left: unknown, right: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[left, right]];
  while (pending.length > 0) {
    const [currentLeft, currentRight] = pending.pop()!;
    if (currentLeft === currentRight) continue;
    if (
      currentLeft === null
      || currentRight === null
      || typeof currentLeft !== 'object'
      || typeof currentRight !== 'object'
    ) {
      return false;
    }
    const leftIsArray = Array.isArray(currentLeft);
    if (leftIsArray !== Array.isArray(currentRight)) return false;
    if (leftIsArray) {
      const leftItems = currentLeft as readonly unknown[];
      const rightItems = currentRight as readonly unknown[];
      if (leftItems.length !== rightItems.length) return false;
      for (let index = 0; index < leftItems.length; index += 1) {
        pending.push([leftItems[index]!, rightItems[index]!]);
      }
      continue;
    }
    const leftRecord = currentLeft as Readonly<Record<string, unknown>>;
    const rightRecord = currentRight as Readonly<Record<string, unknown>>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
      pending.push([leftRecord[key]!, rightRecord[key]!]);
    }
  }
  return true;
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
