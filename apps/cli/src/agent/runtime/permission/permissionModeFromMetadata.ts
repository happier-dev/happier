import type { Metadata, PermissionMode } from '@/api/types';
import { isPermissionMode } from '@/api/types';
import {
  LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
  resolveMetadataStringOverrideV1,
  resolvePermissionIntentFromSessionMetadata,
  SESSION_MODE_OVERRIDE_KEY,
} from '@happier-dev/agents';

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
  const resolved =
    resolveMetadataStringOverrideV1(opts.metadata ?? null, SESSION_MODE_OVERRIDE_KEY, 'modeId') ??
    resolveMetadataStringOverrideV1(opts.metadata ?? null, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY, 'modeId');
  if (!resolved) return null;
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

export function resolveModelOverrideFromMetadataSnapshot(opts: {
  metadata: Metadata | null | undefined;
}): { modelId: string; updatedAt: number } | null {
  const resolved = resolveMetadataStringOverrideV1(opts.metadata ?? null, 'modelOverrideV1', 'modelId');
  if (!resolved) return null;
  // "default" is a UI sentinel meaning "no override" (do not attempt to set a provider model id to "default").
  if (resolved.value === 'default') return null;
  return { modelId: resolved.value, updatedAt: resolved.updatedAt };
}

export function computePendingModelOverrideApplication(opts: {
  metadata: Metadata | null | undefined;
  lastAppliedUpdatedAt: number;
}): { modelId: string; updatedAt: number } | null {
  const resolved = resolveModelOverrideFromMetadataSnapshot({ metadata: opts.metadata });
  if (!resolved) return null;
  if (resolved.updatedAt <= opts.lastAppliedUpdatedAt) return null;
  return resolved;
}
