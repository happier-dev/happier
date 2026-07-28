import type { PermissionIntent } from '../types.js';
import { parsePermissionIntentAlias } from '../permissions/index.js';
import {
  LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  readNewestMetadataAliasValue,
  SESSION_CONFIG_OPTION_OVERRIDES_KEY,
  SESSION_MODELS_STATE_KEY,
} from './metadataKeys.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export type MetadataStringOverrideStateV1 =
  | { state: 'set'; value: string; updatedAt: number }
  | { state: 'cleared'; updatedAt: number };

type SessionModelOptionValueV1 = string | number | boolean | null;

type SessionModelOptionMetadataV1 = Readonly<{
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: SessionModelOptionValueV1;
  options?: readonly Readonly<{
    value: SessionModelOptionValueV1;
    name: string;
    description?: string;
    [key: string]: unknown;
  }>[];
  [key: string]: unknown;
}>;

export type SessionModelsMetadataStateV1 = Readonly<{
  v: 1;
  provider: string;
  updatedAt: number;
  currentModelId: string;
  availableModels: readonly Readonly<{
    id: string;
    name: string;
    description?: string;
    modelOptions?: readonly SessionModelOptionMetadataV1[];
    [key: string]: unknown;
  }>[];
}>;

function isSessionModelOptionValueV1(value: unknown): value is SessionModelOptionValueV1 {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function isSessionModelOptionMetadataV1(raw: unknown): raw is SessionModelOptionMetadataV1 {
  const option = asRecord(raw);
  if (!option || typeof option.id !== 'string' || !option.id.trim()) return false;
  if (typeof option.name !== 'string' || !option.name.trim()) return false;
  if (typeof option.type !== 'string' || !option.type.trim()) return false;
  if (!isSessionModelOptionValueV1(option.currentValue)) return false;
  if (option.description !== undefined && typeof option.description !== 'string') return false;
  if (option.category !== undefined && typeof option.category !== 'string') return false;
  if (option.options !== undefined) {
    if (!Array.isArray(option.options)) return false;
    for (const rawChoice of option.options) {
      const choice = asRecord(rawChoice);
      if (!choice || !isSessionModelOptionValueV1(choice.value)) return false;
      if (typeof choice.name !== 'string' || !choice.name.trim()) return false;
      if (choice.description !== undefined && typeof choice.description !== 'string') return false;
    }
  }
  return true;
}

export type SessionConfigOptionOverridesMetadataStateV1 = Readonly<{
  v: 1;
  updatedAt: number;
  overrides: Readonly<Record<string, Readonly<{
    updatedAt: number;
    value: string | number | boolean | null;
  }>>>;
}>;

/** Validates the shared model-state envelope before alias timestamp comparison. */
export function parseSessionModelsMetadataStateV1(raw: unknown): SessionModelsMetadataStateV1 | null {
  const record = asRecord(raw);
  if (!record || record.v !== 1) return null;
  if (typeof record.provider !== 'string' || !record.provider.trim()) return null;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return null;
  if (typeof record.currentModelId !== 'string' || !record.currentModelId.trim()) return null;
  if (!Array.isArray(record.availableModels)) return null;
  for (const rawModel of record.availableModels) {
    const model = asRecord(rawModel);
    if (!model) return null;
    if (typeof model.id !== 'string' || !model.id.trim()) return null;
    if (typeof model.name !== 'string' || !model.name.trim()) return null;
    if (model.description !== undefined && typeof model.description !== 'string') return null;
    if (model.modelOptions !== undefined) {
      if (!Array.isArray(model.modelOptions)) return null;
      for (const rawOption of model.modelOptions) {
        if (!isSessionModelOptionMetadataV1(rawOption)) return null;
      }
    }
  }
  return record as SessionModelsMetadataStateV1;
}

/** Validates config-command state, including explicit null tombstones, before alias selection. */
export function parseSessionConfigOptionOverridesMetadataStateV1(
  raw: unknown,
): SessionConfigOptionOverridesMetadataStateV1 | null {
  const record = asRecord(raw);
  if (!record || record.v !== 1) return null;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return null;
  const overrides = asRecord(record.overrides);
  if (!overrides) return null;
  for (const rawEntry of Object.values(overrides)) {
    const entry = asRecord(rawEntry);
    if (!entry) return null;
    if (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) return null;
    const value = entry.value;
    if (
      value !== null
      && typeof value !== 'string'
      && typeof value !== 'boolean'
      && !(typeof value === 'number' && Number.isFinite(value))
    ) return null;
  }
  return record as SessionConfigOptionOverridesMetadataStateV1;
}

export function readNewestSessionModelsMetadataStateV1(
  metadata: Record<string, unknown> | null | undefined,
): SessionModelsMetadataStateV1 | null {
  return readNewestMetadataAliasValue({
    metadata,
    keys: [SESSION_MODELS_STATE_KEY, LEGACY_ACP_SESSION_MODELS_STATE_KEY],
    parse: parseSessionModelsMetadataStateV1,
  }) ?? null;
}

export function readNewestSessionConfigOptionOverridesMetadataStateV1(
  metadata: Record<string, unknown> | null | undefined,
): SessionConfigOptionOverridesMetadataStateV1 | null {
  return readNewestMetadataAliasValue({
    metadata,
    keys: [SESSION_CONFIG_OPTION_OVERRIDES_KEY, LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY],
    parse: parseSessionConfigOptionOverridesMetadataStateV1,
  }) ?? null;
}

/**
 * Resolve the canonical permission intent from a session metadata snapshot.
 *
 * This is shared across UI/CLI so that legacy aliases and persistence rules stay consistent.
 */
export function resolvePermissionIntentFromSessionMetadata(
  metadata: unknown,
): { intent: PermissionIntent; updatedAt: number } | null {
  const obj = asRecord(metadata);
  if (!obj) return null;

  const rawMode = typeof obj.permissionMode === 'string' ? obj.permissionMode.trim() : '';
  if (!rawMode) return null;

  const intent = parsePermissionIntentAlias(rawMode);
  if (!intent) return null;

  const updatedAt = asFiniteNumber(obj.permissionModeUpdatedAt);
  return { intent, updatedAt };
}

/**
 * Resolve a nested `{ v: 1, updatedAt, <valueKey> }` override from session metadata.
 *
 * This state-aware reader preserves explicit clear tombstones (`null`, empty strings,
 * or whitespace strings) so runtime consumers can clear stale in-memory state. Missing
 * value keys remain malformed/missing data, not clears.
 */
export function resolveMetadataStringOverrideStateV1(
  metadata: unknown,
  overrideKey: string,
  valueKey: string,
): MetadataStringOverrideStateV1 | null {
  const obj = asRecord(metadata);
  if (!obj) return null;

  const rawOverride = asRecord(obj[overrideKey]);
  if (!rawOverride) return null;
  if (!Object.prototype.hasOwnProperty.call(rawOverride, valueKey)) return null;

  const updatedAt = asFiniteNumber(rawOverride.updatedAt);
  const rawValue = rawOverride[valueKey];
  if (typeof rawValue === 'string') {
    const value = rawValue.trim();
    return value ? { state: 'set', value, updatedAt } : { state: 'cleared', updatedAt };
  }
  if (rawValue === null) return { state: 'cleared', updatedAt };
  return null;
}

/**
 * Resolve the newest valid state across canonical + legacy override aliases.
 *
 * Pass keys in canonical-preferred order; equal timestamps keep the first valid key.
 */
export function resolveMetadataStringOverrideStateV1FromAliases(
  metadata: unknown,
  overrideKeys: readonly string[],
  valueKey: string,
): MetadataStringOverrideStateV1 | null {
  let best: MetadataStringOverrideStateV1 | null = null;
  for (const overrideKey of overrideKeys) {
    const next = resolveMetadataStringOverrideStateV1(metadata, overrideKey, valueKey);
    if (!next) continue;
    if (!best || next.updatedAt > best.updatedAt) {
      best = next;
    }
  }
  return best;
}

/**
 * Resolve a nested `{ v: 1, updatedAt, <valueKey>: string }` override from session metadata.
 *
 * Used for fields like:
 * - `metadata.modelOverrideV1 = { v: 1, updatedAt, modelId }`
 * - `metadata.acpSessionModeOverrideV1 = { v: 1, updatedAt, modeId }`
 *
 * This compatibility wrapper is intentionally set-only; callers that must observe
 * clears should use `resolveMetadataStringOverrideStateV1`.
 */
export function resolveMetadataStringOverrideV1(
  metadata: unknown,
  overrideKey: string,
  valueKey: string,
): { value: string; updatedAt: number } | null {
  const resolved = resolveMetadataStringOverrideStateV1(metadata, overrideKey, valueKey);
  if (resolved?.state !== 'set') return null;
  return { value: resolved.value, updatedAt: resolved.updatedAt };
}
