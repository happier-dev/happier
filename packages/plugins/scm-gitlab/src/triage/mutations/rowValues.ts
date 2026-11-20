import { normalizeTriageSingleLineV1 } from '@happier-dev/triage-protocol/v1';

export function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function readLabel(value: unknown): string | null {
  const text = readNonEmptyString(value);
  if (text === null) return null;
  const normalized = normalizeTriageSingleLineV1(text);
  return normalized === '' ? null : normalized;
}

export function readTimestampMs(value: unknown): number | null {
  const text = readNonEmptyString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readUsernameList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  for (const member of value) {
    const item = readLabel(readRecord(member)?.username);
    if (item === null) return undefined;
    if (!values.includes(item)) values.push(item);
  }
  return Object.freeze(values);
}
