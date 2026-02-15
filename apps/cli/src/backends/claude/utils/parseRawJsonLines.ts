import { RawJSONLinesSchema, type RawJSONLines } from '../types';

export function parseRawJsonLinesObject(value: unknown): RawJSONLines | null {
  const parsed = RawJSONLinesSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

export function parseRawJsonLinesLine(line: string): RawJSONLines | null {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return parseRawJsonLinesObject(obj);
}

