import type { ExecutionRunRuntimeSettings } from './executionRunTypes';

function sanitizeRuntimeSettingValue(
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    return Object.freeze(value.map((item) => {
      const sanitized = sanitizeRuntimeSettingValue(item, seen);
      return typeof sanitized === 'undefined' ? null : sanitized;
    }));
  }
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    const sanitized = sanitizeRuntimeSettingValue(item, seen);
    if (typeof sanitized !== 'undefined') {
      out[key] = sanitized;
    }
  }
  return Object.freeze(out);
}

export function sanitizeExecutionRunAccountSettingsSnapshot(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  const sanitized = sanitizeRuntimeSettingValue(value, new WeakSet());
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Readonly<Record<string, unknown>>
    : null;
}

export function resolveExecutionRunRuntimeSettings(params: Readonly<{
  accountSettings?: unknown;
}>): ExecutionRunRuntimeSettings | undefined {
  const accountSettings = sanitizeExecutionRunAccountSettingsSnapshot(params.accountSettings);
  return accountSettings ? { accountSettings } : undefined;
}
