import { ProviderSettingsV1Schema, type ProviderSettingsV1 } from './v1.js';

export type ProviderSettingsSubtreeClassificationV1 =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'current'; settings: ProviderSettingsV1 }>
  | Readonly<{ kind: 'future'; version: number }>
  | Readonly<{ kind: 'malformed' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function classifyProviderSettingsSubtreeV1(
  rawAccountSettings: unknown,
): ProviderSettingsSubtreeClassificationV1 {
  if (!isRecord(rawAccountSettings)) return { kind: 'malformed' };
  if (!Object.prototype.hasOwnProperty.call(rawAccountSettings, 'providerSettingsV1')) return { kind: 'absent' };
  const subtree = rawAccountSettings.providerSettingsV1;
  if (isRecord(subtree)
    && typeof subtree.v === 'number'
    && Number.isInteger(subtree.v)
    && subtree.v > 1) {
    return { kind: 'future', version: subtree.v };
  }
  const parsed = ProviderSettingsV1Schema.safeParse(subtree);
  return parsed.success ? { kind: 'current', settings: parsed.data } : { kind: 'malformed' };
}
