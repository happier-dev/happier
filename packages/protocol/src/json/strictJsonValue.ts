import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { cloneNativeJsonValueForTransport, cloneStrictPluginJsonValue } from '../plugins/contributions/strictJsonValue.js';

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

/** Projects native optional object members; unsupported JSON data still fails closed. */
export function projectNativeJsonValueForTransport(input: unknown): JsonValue {
  return cloneNativeJsonValueForTransport(input, 'value') as JsonValue;
}

/**
 * Compares admitted JSON without depending on object insertion order. Native
 * carriers can opt into transport's omission of undefined object members;
 * comparison never validates, clones or re-admits either input.
 */
export function sameStrictJsonValue(left: unknown, right: unknown,
  options?: Readonly<{ omitUndefinedObjectMembers: true }>): boolean {
  if (left === right) return true;
  // Keep one reusable frame per nesting level. A wide Usage curve must not
  // allocate a pending pair for every point and each of its scalar fields.
  const frames: Array<{
    left: object; right: object; keys: string[] | undefined; index: number; length: number;
  }> = [];
  let depth = 0;
  let currentLeft = left;
  let currentRight = right;
  for (;;) {
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
    let keys: string[] | undefined;
    let length: number;
    if (leftIsArray) {
      const leftItems = currentLeft as readonly unknown[];
      const rightItems = currentRight as readonly unknown[];
      if (leftItems.length !== rightItems.length) return false;
      length = leftItems.length;
    } else {
      keys = Object.keys(currentLeft);
      let rightKeys = Object.keys(currentRight);
      if (options?.omitUndefinedObjectMembers) {
        const leftRecord = currentLeft as Readonly<Record<string, unknown>>;
        const rightRecord = currentRight as Readonly<Record<string, unknown>>;
        keys = keys.filter(key => leftRecord[key] !== undefined);
        rightKeys = rightKeys.filter(key => rightRecord[key] !== undefined);
      }
      length = keys.length;
      if (length !== rightKeys.length) return false;
    }
    const frame = frames[depth];
    if (frame) {
      frame.left = currentLeft; frame.right = currentRight; frame.keys = keys; frame.index = 0; frame.length = length;
    } else frames.push({ left: currentLeft, right: currentRight, keys, index: 0, length });
    depth++;
    let different = false;
    while (depth > 0) {
      const active = frames[depth - 1]!;
      if (active.index === active.length) { depth--; continue; }
      const index = active.index++;
      if (active.keys) {
        const key = active.keys[index]!;
        if (!Object.prototype.hasOwnProperty.call(active.right, key)) return false;
        currentLeft = (active.left as Readonly<Record<string, unknown>>)[key];
        currentRight = (active.right as Readonly<Record<string, unknown>>)[key];
      } else {
        currentLeft = (active.left as readonly unknown[])[index];
        currentRight = (active.right as readonly unknown[])[index];
      }
      if (currentLeft !== currentRight) { different = true; break; }
    }
    if (!different) return true;
  }
}

const StrictJsonValueNormalizationSchema = z.transform((value, context): JsonValue => {
  try {
    return normalizeStrictJsonValue(value);
  } catch (error) {
    context.issues.push({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid strict JSON value', input: context.value });
    return z.NEVER;
  }
});

export const StrictJsonValueSchema = lazyZodSchema(() => z.pipe(z.unknown(), StrictJsonValueNormalizationSchema));

/** Normalize before parsing while letting JSON Schema discovery see the typed input. */
export function withStrictJsonInput<TSchema extends z.core.$ZodType<unknown, JsonValue>>(schema: TSchema): z.ZodMiniPipe<typeof StrictJsonValueNormalizationSchema, TSchema> {
  return z.pipe(StrictJsonValueNormalizationSchema, schema);
}
