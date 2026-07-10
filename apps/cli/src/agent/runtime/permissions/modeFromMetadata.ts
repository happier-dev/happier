import type { Metadata, PermissionMode } from '@/api/types';
import { isPermissionMode } from '@/api/types';
import {
  readAcpSessionModeIntentFromMetadata,
  resolveModelSelectionIntentFromSessionMetadata,
  resolvePermissionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import type { SessionModelSelectionIntentV1 } from '@happier-dev/protocol';

function metadataHasConcreteDefaultSessionMode(metadata: Metadata | null | undefined): boolean {
  const candidate = metadata as {
    sessionModesV1?: unknown;
    acpSessionModesV1?: unknown;
  } | null | undefined;
  const states = [candidate?.sessionModesV1, candidate?.acpSessionModesV1];
  return states.some((state) => {
    if (!state || typeof state !== 'object') return false;
    const availableModes = (state as { availableModes?: unknown }).availableModes;
    if (!Array.isArray(availableModes)) return false;
    return availableModes.some((mode) => (
      mode !== null
      && typeof mode === 'object'
      && (mode as { id?: unknown }).id === 'default'
    ));
  });
}

export function resolvePermissionIntentFromMetadataSnapshot(opts: {
  metadata: Metadata | null | undefined;
}): { intent: PermissionMode; updatedAt: number } | null {
  const resolved = resolvePermissionIntentFromSessionMetadata(opts.metadata ?? null);
  if (!resolved) return null;
  // Defensive: keep cli PermissionMode as the runtime gate until the schema is narrowed.
  if (!isPermissionMode(resolved.intent)) return null;
  return { intent: resolved.intent, updatedAt: resolved.updatedAt };
}

export function resolveSessionModeOverrideFromMetadataSnapshot(opts: {
  metadata: Metadata | null | undefined;
}): { modeId: string; updatedAt: number } | null {
  const resolvedIntent = readAcpSessionModeIntentFromMetadata((opts.metadata ?? {}) as Metadata);
  const resolved = resolvedIntent
    ? { value: resolvedIntent.modeId ?? '', updatedAt: resolvedIntent.updatedAt }
    : null;
  if (!resolved) return null;
  if (resolved.value === 'default' && !metadataHasConcreteDefaultSessionMode(opts.metadata)) {
    return { modeId: '', updatedAt: resolved.updatedAt };
  }
  return { modeId: resolved.value, updatedAt: resolved.updatedAt };
}

export function computePendingSessionModeOverrideApplication(opts: {
  metadata: Metadata | null | undefined;
  lastAppliedUpdatedAt: number;
}): { modeId: string; updatedAt: number } | null {
  const resolved = resolveSessionModeOverrideFromMetadataSnapshot({ metadata: opts.metadata });
  if (!resolved) return null;
  if (resolved.updatedAt <= opts.lastAppliedUpdatedAt) return null;
  return resolved;
}

export const resolveAcpSessionModeOverrideFromMetadataSnapshot = resolveSessionModeOverrideFromMetadataSnapshot;
export const computePendingAcpSessionModeOverrideApplication = computePendingSessionModeOverrideApplication;

/**
 * Resolve the canonical model-selection intent only after the owning session target is known.
 * The agents package owns canonical-vs-deployed timestamp precedence and target validation.
 */
export function resolveModelSelectionIntentFromMetadataSnapshot(opts: {
  metadata: Metadata | null | undefined;
  agentTargetKey: string;
}): SessionModelSelectionIntentV1 | null {
  return resolveModelSelectionIntentFromSessionMetadata(
    opts.metadata ?? null,
    opts.agentTargetKey,
  );
}

export function computePendingModelSelectionIntentApplication(opts: {
  metadata: Metadata | null | undefined;
  agentTargetKey: string;
  lastAppliedUpdatedAt: number;
}): SessionModelSelectionIntentV1 | null {
  const resolved = resolveModelSelectionIntentFromMetadataSnapshot({
    metadata: opts.metadata,
    agentTargetKey: opts.agentTargetKey,
  });
  if (!resolved || resolved.updatedAt <= opts.lastAppliedUpdatedAt) return null;
  return resolved;
}
