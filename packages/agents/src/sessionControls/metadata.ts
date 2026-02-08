import type { PermissionIntent } from '../types.js';
import { parsePermissionIntentAlias } from '../permissions/index.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
 * Resolve a nested `{ v: 1, updatedAt, <valueKey>: string }` override from session metadata.
 *
 * Used for fields like:
 * - `metadata.modelOverrideV1 = { v: 1, updatedAt, modelId }`
 * - `metadata.acpSessionModeOverrideV1 = { v: 1, updatedAt, modeId }`
 */
export function resolveMetadataStringOverrideV1(
  metadata: unknown,
  overrideKey: string,
  valueKey: string,
): { value: string; updatedAt: number } | null {
  const obj = asRecord(metadata);
  if (!obj) return null;

  const rawOverride = asRecord(obj[overrideKey]);
  if (!rawOverride) return null;

  const rawValue = rawOverride[valueKey];
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) return null;

  const updatedAt = asFiniteNumber(rawOverride.updatedAt);
  return { value, updatedAt };
}

