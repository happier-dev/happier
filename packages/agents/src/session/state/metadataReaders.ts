import type { PermissionIntent } from '../../types.js';
import {
  parseBackendTargetKeyV2,
} from '@happier-dev/protocol/plugins/agents';
import {
  resolveSessionModelSelectionIntentV1,
  type ProviderBoundModelRef,
  type SessionModelSelectionIntentV1,
} from '@happier-dev/protocol/providers/model-selection';
import {
  readExactSessionActiveModelSelectionV1,
} from '@happier-dev/protocol/providers/active-model-selection';
import {
  readPermissionModeIntentFromMetadata,
  readStringOverrideIntentFromMetadata,
} from './bindings/intent.js';
import { MODEL_OVERRIDE_KEY, MODEL_SELECTION_INTENT_KEY } from './bindings/metadataKeys.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Returns model selection only when the Protocol owner proves it against the
 * exact current physical runner and, for Provider-bound selections, the exact
 * applied binding. Persisted intent and fallback catalogs are excluded.
 */
export function readActiveSessionModelSelectionFromMetadata(
  metadata: unknown,
  agentTargetKey: string,
  currentRunnerProcessIdentity: Readonly<{
    pid: number;
    processStartTimeMs: number;
  }> | null,
): ProviderBoundModelRef | null {
  const record = asRecord(metadata);
  if (!record) return null;

  let targetAgentId: string;
  try {
    targetAgentId = parseBackendTargetKeyV2(agentTargetKey).backendId;
  } catch {
    return null;
  }

  return readExactSessionActiveModelSelectionV1({
    metadata: record,
    agentId: targetAgentId,
    agentTargetKey,
    currentRunnerProcessIdentity,
  })?.selection ?? null;
}

/** Resolve canonical and deployed model intent once the session's canonical target is known. */
export function resolveModelSelectionIntentFromSessionMetadata(
  metadata: unknown,
  agentTargetKey: string,
): SessionModelSelectionIntentV1 | null {
  const obj = asRecord(metadata);
  if (!obj) return null;
  return resolveSessionModelSelectionIntentV1({
    canonical: obj[MODEL_SELECTION_INTENT_KEY],
    legacy: obj[MODEL_OVERRIDE_KEY],
    agentTargetKey,
  });
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

  const value = readPermissionModeIntentFromMetadata(obj);
  return value ? { intent: value.permissionMode as PermissionIntent, updatedAt: value.updatedAt } : null;
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

  if (overrideKey === MODEL_OVERRIDE_KEY && valueKey === 'modelId') {
    // This generic string helper is a deployed-legacy reader only. Canonical provider-bound
    // selections require a known agent target and are resolved through the structured reader.
    const value = readStringOverrideIntentFromMetadata({
      metadata: obj,
      overrideKey,
      valueKey,
    });
    return typeof value?.value === 'string' && value.value.trim()
      ? { value: value.value.trim(), updatedAt: value.updatedAt }
      : null;
  }

  const value = readStringOverrideIntentFromMetadata({
    metadata: obj,
    overrideKey,
    valueKey,
  });
  return value && value.value !== null ? { value: value.value, updatedAt: value.updatedAt } : null;
}
