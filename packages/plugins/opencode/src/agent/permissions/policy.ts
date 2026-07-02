import { parsePermissionIntentAlias, type PermissionMode } from '@happier-dev/agents';
import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';

export type OpenCodePermissionValue = 'allow' | 'deny' | 'ask';

const OPENCODE_READ_PERMISSIONS = ['read', 'glob', 'grep', 'list', 'ls'] as const;
const OPENCODE_EDIT_PERMISSIONS = ['edit', 'write'] as const;
const OPENCODE_OTHER_COMMON_PERMISSIONS = ['bash', 'task'] as const;
const OPENCODE_SAFE_TOOL_NAME_TOKENS = [
  'session_title_set',
  'save_memory',
  'think',
] as const;
const OPENCODE_GUARD_PERMISSIONS = ['external_directory', 'doom_loop'] as const;
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
const OPENCODE_SAFE_ALLOW_PERMISSIONS = [
  ...CHANGE_TITLE_TOOL_NAME_ALIASES,
  ...OPENCODE_HAPPIER_ACTION_TOOL_NAME_ALIASES,
  ...OPENCODE_SAFE_TOOL_NAME_TOKENS,
] as const;
const OPENCODE_KNOWN_PERMISSION_KEYS = [
  ...OPENCODE_READ_PERMISSIONS,
  ...OPENCODE_EDIT_PERMISSIONS,
  ...OPENCODE_OTHER_COMMON_PERMISSIONS,
  ...OPENCODE_SAFE_ALLOW_PERMISSIONS,
  ...OPENCODE_GUARD_PERMISSIONS,
] as const;

function setList(
  permissions: ReadonlyArray<string>,
  value: OpenCodePermissionValue,
): Record<string, OpenCodePermissionValue> {
  return Object.fromEntries(permissions.map((permission) => [permission, value] as const));
}

function allowList(permissions: ReadonlyArray<string>): Record<string, OpenCodePermissionValue> {
  return setList(permissions, 'allow');
}

function asIntent(mode: PermissionMode | null | undefined): 'default' | 'read-only' | 'safe-yolo' | 'yolo' | 'plan' {
  return parsePermissionIntentAlias(mode ?? 'default') ?? 'default';
}

export function resolveOpenCodePermissionConfig(
  permissionMode: PermissionMode | null | undefined,
): Record<string, OpenCodePermissionValue> {
  const intent = asIntent(permissionMode);

  if (intent === 'yolo') {
    return {
      '*': 'allow',
      ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'allow'),
      ...allowList(OPENCODE_SAFE_ALLOW_PERMISSIONS),
    };
  }

  if (intent === 'safe-yolo') {
    return {
      '*': 'ask',
      ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'ask'),
      ...allowList(OPENCODE_SAFE_ALLOW_PERMISSIONS),
      ...allowList(OPENCODE_READ_PERMISSIONS),
      ...allowList(OPENCODE_EDIT_PERMISSIONS),
    };
  }

  if (intent === 'read-only' || intent === 'plan') {
    return {
      '*': 'deny',
      ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'deny'),
      ...allowList(OPENCODE_SAFE_ALLOW_PERMISSIONS),
      ...allowList(OPENCODE_READ_PERMISSIONS),
    };
  }

  return {
    '*': 'ask',
    ...setList(OPENCODE_KNOWN_PERMISSION_KEYS, 'ask'),
    ...allowList(OPENCODE_SAFE_ALLOW_PERMISSIONS),
    ...allowList(OPENCODE_READ_PERMISSIONS),
  };
}

export function buildOpenCodeSessionPermissionRuleset(
  permissionMode: PermissionMode | null | undefined,
): ReadonlyArray<Readonly<{ permission: string; pattern: string; action: OpenCodePermissionValue }>> {
  return Object.entries(resolveOpenCodePermissionConfig(permissionMode)).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }));
}

export function buildOpenCodePermissionEnv(
  permissionMode: PermissionMode | null | undefined,
): Readonly<Record<string, string>> {
  return {
    OPENCODE_PERMISSION: JSON.stringify(resolveOpenCodePermissionConfig(permissionMode)),
  };
}
