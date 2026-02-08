import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permissionModeFromMetadata';
import type { PermissionMode } from '@/api/types';
import { mapToClaudeMode } from './permissionMode';

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

  const claudeMode = mapToClaudeMode(resolved.intent);
  const didChange = opts.session.adoptLastPermissionModeFromMetadata(claudeMode, resolved.updatedAt);
  if (!didChange) return null;

  opts.permissionHandler.handleModeChange(claudeMode);
  return claudeMode;
}
