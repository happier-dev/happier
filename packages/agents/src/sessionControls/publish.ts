import { parsePermissionIntentAlias } from '../permissions/index.js';
import { computeMonotonicUpdatedAt } from './monotonic.js';

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function computeNextPermissionIntentMetadata(params: Readonly<{
  metadata: Record<string, unknown>;
  permissionMode: string;
  permissionModeUpdatedAt: number;
}>): Record<string, unknown> {
  // Invalid/unknown aliases are ignored (no-op) to avoid persisting unintended defaults.
  const canonical = parsePermissionIntentAlias(params.permissionMode);
  if (!canonical) return params.metadata;

  const prevUpdatedAt = asFiniteNumber(params.metadata.permissionModeUpdatedAt);
  const prevMode = asTrimmedString(params.metadata.permissionMode);

  const nextUpdatedAt = computeMonotonicUpdatedAt({
    previousUpdatedAt: prevUpdatedAt,
    desiredUpdatedAt: asFiniteNumber(params.permissionModeUpdatedAt),
    previousValue: prevMode,
    desiredValue: canonical,
    policy: 'ignore_older',
  });
  if (nextUpdatedAt === null) return params.metadata;

  return {
    ...params.metadata,
    permissionMode: canonical,
    permissionModeUpdatedAt: nextUpdatedAt,
  };
}

export function computeNextMetadataStringOverrideV1(params: Readonly<{
  metadata: Record<string, unknown>;
  overrideKey: string;
  valueKey: string;
  value: string;
  updatedAt: number;
}>): Record<string, unknown> {
  const overrideKey = asTrimmedString(params.overrideKey);
  const valueKey = asTrimmedString(params.valueKey);
  if (!overrideKey || !valueKey) return params.metadata;

  const value = asTrimmedString(params.value);
  const isClear = !value;

  const prev = params.metadata[overrideKey] as Record<string, unknown> | null | undefined;
  const prevUpdatedAt = prev ? asFiniteNumber(prev.updatedAt) : 0;
  const prevRawValue = prev ? prev[valueKey] : null;
  const prevValue = typeof prevRawValue === 'string' && prevRawValue.trim() ? prevRawValue.trim() : '__cleared__';
  const desiredValue = isClear ? '__cleared__' : value;

  const nextUpdatedAt = computeMonotonicUpdatedAt({
    previousUpdatedAt: prevUpdatedAt,
    desiredUpdatedAt: asFiniteNumber(params.updatedAt),
    previousValue: prevValue,
    desiredValue,
    // Local explicit override changes (including clear) should win deterministically.
    policy: 'force_update',
  });
  if (nextUpdatedAt === null) return params.metadata;

  return {
    ...params.metadata,
    [overrideKey]: {
      v: 1,
      updatedAt: nextUpdatedAt,
      [valueKey]: isClear ? null : value,
    },
  };
}

function normalizeConfigOptionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeConfigOptionValueId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function computeNextMetadataConfigOptionOverrideV1(params: Readonly<{
  metadata: Record<string, unknown>;
  configId: string;
  value: unknown;
  updatedAt: number;
}>): Record<string, unknown> {
  const configId = normalizeConfigOptionId(params.configId);
  if (!configId) return params.metadata;
  const valueId = normalizeConfigOptionValueId(params.value);
  if (!valueId) return params.metadata;

  const rootKey = 'acpConfigOptionOverridesV1';
  const prevRoot = params.metadata[rootKey] as Record<string, unknown> | null | undefined;
  const prevUpdatedAt = prevRoot ? asFiniteNumber(prevRoot.updatedAt) : 0;

  const prevOverridesRaw = prevRoot?.overrides;
  const prevOverrides =
    prevOverridesRaw && typeof prevOverridesRaw === 'object' && !Array.isArray(prevOverridesRaw)
      ? (prevOverridesRaw as Record<string, unknown>)
      : {};

  const prevEntryRaw = prevOverrides[configId] as Record<string, unknown> | null | undefined;
  const prevEntryUpdatedAt = prevEntryRaw ? asFiniteNumber(prevEntryRaw.updatedAt) : 0;
  const prevEntryValueRaw = prevEntryRaw ? prevEntryRaw.value : undefined;

  const desiredUpdatedAt = asFiniteNumber(params.updatedAt);
  const desiredValue = valueId;

  const nextEntryUpdatedAt = computeMonotonicUpdatedAt({
    previousUpdatedAt: prevEntryUpdatedAt,
    desiredUpdatedAt,
    previousValue: JSON.stringify(prevEntryValueRaw ?? null),
    desiredValue: JSON.stringify(desiredValue),
    policy: 'ignore_older',
  });
  if (nextEntryUpdatedAt === null) return params.metadata;

  const nextOverrides: Record<string, unknown> = { ...prevOverrides };
  nextOverrides[configId] = { updatedAt: nextEntryUpdatedAt, value: desiredValue };

  const nextRootUpdatedAt = Math.max(prevUpdatedAt, nextEntryUpdatedAt);

  return {
    ...params.metadata,
    [rootKey]: {
      v: 1,
      updatedAt: nextRootUpdatedAt,
      overrides: nextOverrides,
    },
  };
}
