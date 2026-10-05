export function isRecord(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);
}

export function readRecord(raw: unknown): Readonly<Record<string, unknown>> {
  return isRecord(raw) ? raw : {};
}

export function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function readRecordListProperty(raw: unknown, key: string): readonly Readonly<Record<string, unknown>>[] {
  const value = readRecord(raw)[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function readNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
