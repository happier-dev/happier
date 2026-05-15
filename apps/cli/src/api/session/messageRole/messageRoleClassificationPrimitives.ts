export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readStringProperty(value: unknown, property: string): string | null {
  const record = asRecord(value);
  const raw = record?.[property];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

export function readType(value: unknown): string | null {
  return readStringProperty(value, 'type');
}

export function readNestedProperty(value: unknown, property: string): unknown {
  return asRecord(value)?.[property];
}
