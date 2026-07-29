import {
  parsePermissionIntentAlias,
  type PermissionIntent,
} from '@happier-dev/agents';

/**
 * Execution-run permission policies are intentionally restrictive and use
 * historical tokens like `read_only` / `no_tools`.
 *
 * Map them onto the canonical PermissionIntent surface used by Agent runtimes.
 */
export function permissionMode(raw: string): PermissionIntent {
  const mode = String(raw ?? '').trim().toLowerCase();
  if (!mode) return 'default';

  if (mode === 'read_only' || mode === 'no_tools') {
    return 'read-only';
  }

  if (mode === 'workspace_write') {
    // Execution runs default delegate intent policy to workspace-write. Map it to the closest
    // canonical PermissionIntent understood by Agent runtimes.
    return 'safe-yolo';
  }

  return parsePermissionIntentAlias(mode) ?? 'default';
}
