import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';
import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';

export type OpenCodePermissionValue = 'allow' | 'deny' | 'ask';

const OPENCODE_READ_PERMISSIONS = ['read', 'glob', 'grep', 'list', 'ls'] as const;
const OPENCODE_EDIT_PERMISSIONS = ['edit', 'write'] as const;
const OPENCODE_HAPPIER_ACTION_TOOL_NAME_ALIASES = [
  'action_execute',
  'happier_action_execute',
  'happier__action_execute',
  'mcp__happier__action_execute',
  'action_spec_search',
  'happier_action_spec_search',
  'happier__action_spec_search',
  'mcp__happier__action_spec_search',
  'action_spec_get',
  'happier_action_spec_get',
  'happier__action_spec_get',
  'mcp__happier__action_spec_get',
  'action_options_resolve',
  'happier_action_options_resolve',
  'happier__action_options_resolve',
  'mcp__happier__action_options_resolve',
] as const;
const OPENCODE_ALWAYS_ALLOW_PERMISSIONS = [
  ...CHANGE_TITLE_TOOL_NAME_ALIASES,
  ...OPENCODE_HAPPIER_ACTION_TOOL_NAME_ALIASES,
  'save_memory',
  'think',
] as const;
const OPENCODE_GUARD_PERMISSIONS = ['external_directory', 'doom_loop'] as const;
const OPENCODE_OTHER_COMMON_PERMISSIONS = ['bash', 'task'] as const;

const OPENCODE_KNOWN_PERMISSION_KEYS = [
  ...OPENCODE_READ_PERMISSIONS,
  ...OPENCODE_EDIT_PERMISSIONS,
  ...OPENCODE_OTHER_COMMON_PERMISSIONS,
  ...OPENCODE_ALWAYS_ALLOW_PERMISSIONS,
  ...OPENCODE_GUARD_PERMISSIONS,
] as const;

function allowList(perms: ReadonlyArray<string>): Record<string, OpenCodePermissionValue> {
  return Object.fromEntries(perms.map((permission) => [permission, 'allow'] as const));
}

function setList(
  perms: ReadonlyArray<string>,
  value: OpenCodePermissionValue,
): Record<string, OpenCodePermissionValue> {
  return Object.fromEntries(perms.map((permission) => [permission, value] as const));
}

function asIntent(mode: PermissionMode | null | undefined): PermissionMode {
  return normalizePermissionModeToIntent(mode ?? 'default') ?? 'default';
}

export function resolveOpenCodeFamilyPermissionConfig(
  permissionMode: PermissionMode | null | undefined,
): Record<string, OpenCodePermissionValue> {
  const intent = asIntent(permissionMode);

  if (intent === 'yolo' || intent === 'bypassPermissions') {
    return {
      '*': 'allow',
      ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'allow'),
      ...allowList(OPENCODE_ALWAYS_ALLOW_PERMISSIONS),
    };
  }

  if (intent === 'safe-yolo') {
    return {
      '*': 'ask',
      ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'ask'),
      ...allowList(OPENCODE_ALWAYS_ALLOW_PERMISSIONS),
      ...allowList(OPENCODE_READ_PERMISSIONS),
      ...allowList(OPENCODE_EDIT_PERMISSIONS),
    };
  }

  if (intent === 'read-only' || intent === 'plan') {
    return {
      '*': 'deny',
      ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'deny'),
      ...allowList(OPENCODE_ALWAYS_ALLOW_PERMISSIONS),
      ...allowList(OPENCODE_READ_PERMISSIONS),
    };
  }

  return {
    '*': 'ask',
    ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'ask'),
    ...allowList(OPENCODE_ALWAYS_ALLOW_PERMISSIONS),
    ...allowList(OPENCODE_READ_PERMISSIONS),
  };
}

export function buildOpenCodeSessionPermissionRuleset(
  permissionMode: PermissionMode | null | undefined,
): ReadonlyArray<{ permission: string; pattern: string; action: OpenCodePermissionValue }> {
  return Object.entries(resolveOpenCodeFamilyPermissionConfig(permissionMode)).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }));
}
