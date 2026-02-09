import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';

export function applyPermissionModeToCodexPermissionHandler(opts: {
  permissionHandler: { setPermissionMode: (mode: PermissionMode) => void };
  permissionMode: PermissionMode | null | undefined;
}): PermissionMode {
  const raw = opts.permissionMode ?? 'default';
  const normalized = normalizePermissionModeToIntent(raw) ?? 'default';

  opts.permissionHandler.setPermissionMode(normalized);
  return normalized;
}
