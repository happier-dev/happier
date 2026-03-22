import type { PermissionMode } from '@/api/types';
import { resolveOpenCodeFamilyPermissionConfig, type OpenCodePermissionValue } from '@/backends/openCodeFamily/permission/openCodeFamilyPermissionPolicy';

function stringifyPermissionConfig(config: Record<string, OpenCodePermissionValue>): string {
  // OpenCode permission config supports a simple JSON object like:
  //   { "*": "ask", "read": "allow", "edit": "deny", ... }
  return JSON.stringify(config);
}

export function buildOpenCodeFamilyPermissionEnv(permissionMode: PermissionMode | null | undefined): Record<string, string> {
  return {
    OPENCODE_PERMISSION: stringifyPermissionConfig(resolveOpenCodeFamilyPermissionConfig(permissionMode)),
  };
}
