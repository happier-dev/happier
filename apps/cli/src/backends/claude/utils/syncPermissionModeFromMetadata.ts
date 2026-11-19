import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeFromMetadata';
import type { Metadata, PermissionMode } from '@/api/types';

export function syncClaudePermissionModeFromMetadata(opts: {
  session: {
    client: { getMetadataSnapshot: () => Metadata | null | undefined };
    adoptLastPermissionModeFromMetadata: (mode: PermissionMode, updatedAt: number) => boolean;
    lastPermissionMode: PermissionMode;
    lastPermissionModeUpdatedAt: number;
  };
  permissionHandler: { applyMetadataPermissionMode: (mode: PermissionMode, updatedAt: number) => void };
}): PermissionMode | null {
  const resolved = resolvePermissionIntentFromMetadataSnapshot({
    metadata: opts.session.client.getMetadataSnapshot(),
  });
  if (!resolved) return null;
  const adopted = opts.session.adoptLastPermissionModeFromMetadata(resolved.intent, resolved.updatedAt);
  // Session adoption arbitrates desired intent, not whether every reader applied its effects.
  // Another reader may have adopted this broadcast before the native control callback runs.
  const updated = adopted ? resolved : {
    intent: opts.session.lastPermissionMode,
    updatedAt: opts.session.lastPermissionModeUpdatedAt,
  };
  opts.permissionHandler.applyMetadataPermissionMode(updated.intent, updated.updatedAt);
  return updated.intent;
}

export function adoptClaudePermissionModeFromMetadata(opts: {
  session: {
    client: { getMetadataSnapshot: () => Metadata | null | undefined };
    adoptLastPermissionModeFromMetadata: (mode: PermissionMode, updatedAt: number) => boolean;
  };
}): { intent: PermissionMode; updatedAt: number } | null {
  const resolved = resolvePermissionIntentFromMetadataSnapshot({
    metadata: opts.session.client.getMetadataSnapshot(),
  });
  if (!resolved) return null;

  const didChange = opts.session.adoptLastPermissionModeFromMetadata(resolved.intent, resolved.updatedAt);
  if (!didChange) return null;
  return resolved;
}
