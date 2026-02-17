import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';

export function applyPermissionModeToCodexPermissionHandler(opts: {
  permissionHandler: { setPermissionMode: (mode: PermissionMode, updatedAt?: number) => void };
  permissionMode: PermissionMode | null | undefined;
  permissionModeUpdatedAt?: number | null | undefined;
}): PermissionMode {
  const raw = opts.permissionMode ?? 'default';
  const normalized = normalizePermissionModeToIntent(raw) ?? 'default';

  const updatedAtRaw = opts.permissionModeUpdatedAt;
  const updatedAt =
    typeof updatedAtRaw === 'number' && Number.isFinite(updatedAtRaw) && updatedAtRaw > 0
      ? Math.floor(updatedAtRaw)
      : undefined;
  opts.permissionHandler.setPermissionMode(normalized, updatedAt);
  return normalized;
}
