import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeFromMetadata';
import type { PermissionMode } from '@/api/types';

export function syncClaudePermissionModeFromMetadata(opts: {
  session: {
    client: { getMetadataSnapshot: () => any };
    adoptLastPermissionModeFromMetadata: (mode: PermissionMode, updatedAt: number) => boolean;
  };
  permissionHandler: { handleModeChange: (mode: PermissionMode) => void };
}): PermissionMode | null {
  const resolved = resolvePermissionIntentFromMetadataSnapshot({
    metadata: opts.session.client.getMetadataSnapshot(),
  });
  if (!resolved) return null;

  const didChange = opts.session.adoptLastPermissionModeFromMetadata(resolved.intent, resolved.updatedAt);
  if (!didChange) return null;

  opts.permissionHandler.handleModeChange(resolved.intent);
  return resolved.intent;
}
