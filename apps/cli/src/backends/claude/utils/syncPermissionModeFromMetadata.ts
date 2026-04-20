import { applyPermissionIntentFromMetadataIfNewer } from '@/agent/runtime/permissions/modeStateSync';
import type { PermissionMode } from '@/api/types';

export function syncClaudePermissionModeFromMetadata(opts: {
  session: {
    client: { getMetadataSnapshot: () => any };
    lastPermissionModeUpdatedAt: number;
    adoptLastPermissionModeFromMetadata: (mode: PermissionMode, updatedAt: number) => boolean;
  };
  permissionHandler: { handleModeChange: (mode: PermissionMode) => void };
}): PermissionMode | null {
  let nextMode: PermissionMode | null = null;
  applyPermissionIntentFromMetadataIfNewer({
    metadata: opts.session.client.getMetadataSnapshot(),
    currentPermissionModeUpdatedAt: opts.session.lastPermissionModeUpdatedAt,
    apply: ({ intent, updatedAt }) => {
      if (opts.session.adoptLastPermissionModeFromMetadata(intent, updatedAt)) {
        nextMode = intent;
      }
    },
  });
  if (!nextMode) return null;

  opts.permissionHandler.handleModeChange(nextMode);
  return nextMode;
}
