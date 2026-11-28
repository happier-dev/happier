import { createHash } from 'node:crypto';

export type StableJson = null | boolean | number | string | StableJson[] | { [key: string]: StableJson };

function toStableJson(value: unknown, seen: WeakSet<object>): StableJson {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => toStableJson(item, seen));
  if (typeof value !== 'object') return null;

  const objectValue = value as Record<string, unknown>;
  if (seen.has(objectValue)) return null;
  seen.add(objectValue);

  const result: Record<string, StableJson> = {};
  for (const key of Object.keys(objectValue).sort()) {
    const child = objectValue[key];
    if (child === undefined) continue;
    result[key] = toStableJson(child, seen);
  }
  // `seen` tracks the current path only: a cycle collapses to null, while an
  // object shared by two fields still serializes in full under each of them.
  seen.delete(objectValue);
  return result;
}

/** Sorted-key JSON value: undefined fields dropped, non-finite numbers and cycles become null. */
export function toStableJsonValue(value: unknown): StableJson {
  return toStableJson(value, new WeakSet());
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(toStableJson(value, new WeakSet()), null, 0);
}

export function hashStableJsonIdentity(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value), 'utf8').digest('hex');
}
