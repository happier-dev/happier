import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';

type OpenCodePermissionValue = 'allow' | 'deny' | 'ask';

const OPENCODE_READ_PERMISSIONS = ['read', 'glob', 'grep', 'list', 'ls'] as const;
const OPENCODE_EDIT_PERMISSIONS = ['edit', 'write'] as const;
const OPENCODE_ALWAYS_ALLOW_PERMISSIONS = ['change_title', 'save_memory', 'think'] as const;
// Explicit guards used by some OpenCode-family providers.
const OPENCODE_GUARD_PERMISSIONS = ['external_directory', 'doom_loop'] as const;

const OPENCODE_OTHER_COMMON_PERMISSIONS = ['bash', 'task'] as const;

const OPENCODE_KNOWN_PERMISSION_KEYS = [
  ...OPENCODE_READ_PERMISSIONS,
  ...OPENCODE_EDIT_PERMISSIONS,
  ...OPENCODE_OTHER_COMMON_PERMISSIONS,
  ...OPENCODE_ALWAYS_ALLOW_PERMISSIONS,
  ...OPENCODE_GUARD_PERMISSIONS,
] as const;

function asIntent(mode: PermissionMode | null | undefined): PermissionMode {
  return normalizePermissionModeToIntent(mode ?? 'default') ?? 'default';
}

function allowList(perms: ReadonlyArray<string>): Record<string, OpenCodePermissionValue> {
  return Object.fromEntries(perms.map((p) => [p, 'allow'] as const));
}

function setList(
  perms: ReadonlyArray<string>,
  value: OpenCodePermissionValue,
): Record<string, OpenCodePermissionValue> {
  return Object.fromEntries(perms.map((p) => [p, value] as const));
}

function stringifyPermissionConfig(config: Record<string, OpenCodePermissionValue>): string {
  // OpenCode permission config supports a simple JSON object like:
  //   { "*": "ask", "read": "allow", "edit": "deny", ... }
  return JSON.stringify(config);
}

export function buildOpenCodeFamilyPermissionEnv(permissionMode: PermissionMode | null | undefined): Record<string, string> {
  const intent = asIntent(permissionMode);

  if (intent === 'yolo' || intent === 'bypassPermissions') {
    // Allow everything (including edits + execute) without prompts.
    return {
      OPENCODE_PERMISSION: stringifyPermissionConfig({
        '*': 'allow',
        ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'allow'),
        ...allowList(OPENCODE_ALWAYS_ALLOW_PERMISSIONS),
      }),
    };
  }

  if (intent === 'safe-yolo') {
    return {
      OPENCODE_PERMISSION: stringifyPermissionConfig({
        // Safe-yolo: prompt by default, but allow reading + workspace edits without prompting.
        '*': 'ask',
        ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'ask'),
        ...allowList(OPENCODE_ALWAYS_ALLOW_PERMISSIONS),
        ...allowList(OPENCODE_READ_PERMISSIONS),
        ...allowList(OPENCODE_EDIT_PERMISSIONS),
      }),
    };
  }

  if (intent === 'read-only' || intent === 'plan') {
    return {
      OPENCODE_PERMISSION: stringifyPermissionConfig({
        '*': 'deny',
        ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'deny'),
        ...allowList(OPENCODE_ALWAYS_ALLOW_PERMISSIONS),
        ...allowList(OPENCODE_READ_PERMISSIONS),
      }),
    };
  }

  // default: prompt-by-default but allow common read-only tools without prompting.
  return {
    OPENCODE_PERMISSION: stringifyPermissionConfig({
      '*': 'ask',
      ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'ask'),
      ...allowList(OPENCODE_ALWAYS_ALLOW_PERMISSIONS),
      ...allowList(OPENCODE_READ_PERMISSIONS),
    }),
  };
}
