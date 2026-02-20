import type { PermissionMode } from '@/api/types';
import { isPermissionMode } from '@/api/types';

/**
 * Execution-run permission policies are intentionally restrictive and use
 * historical tokens like `read_only` / `no_tools`.
 *
 * Map them onto the canonical PermissionMode surface used by ACP backends.
 */
export function permissionModeForExecutionRunPolicy(raw: string): PermissionMode {
  const mode = String(raw ?? '').trim();
  if (!mode) return 'default';

  if (mode === 'read_only' || mode === 'no_tools') {
    return 'read-only';
  }

  return isPermissionMode(mode) ? mode : 'default';
}

