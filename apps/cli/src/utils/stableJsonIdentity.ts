import { createHash } from 'node:crypto';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function toStableJson(value: unknown, seen: WeakSet<object>): Json {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => toStableJson(item, seen));
  if (typeof value !== 'object') return null;

  const objectValue = value as Record<string, unknown>;
  if (seen.has(objectValue)) return null;
  seen.add(objectValue);

  const result: Record<string, Json> = {};
  for (const key of Object.keys(objectValue).sort()) {
    const child = objectValue[key];
    if (child === undefined) continue;
    result[key] = toStableJson(child, seen);
  }
  return result;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(toStableJson(value, new WeakSet()), null, 0);
}

export function hashStableJsonIdentity(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value), 'utf8').digest('hex');
}
