import { isChangeTitleToolLikeName } from '@happier-dev/protocol/tools/v2';

import { isDefaultWriteLikeToolName } from './writeLikeToolNameHeuristics';

export const SHARED_PERMISSION_SAFE_TOOL_NAME_TOKENS = [
  'session_title_set',
  'save_memory',
  'think',
] as const;

export const SHARED_PERMISSION_GUARD_TOOL_NAMES = [
  'external_directory',
  'doom_loop',
] as const;

function normalizePermissionToolName(toolName: string): string {
  return String(toolName ?? '').trim().toLowerCase();
}

function matchesSharedPermissionToolToken(toolName: string, token: string): boolean {
  if (toolName === token) return true;
  return [
    '_',
    '__',
    '-',
    '/',
    '.',
    ':',
    ' ',
  ].some((boundary) => toolName.endsWith(`${boundary}${token}`));
}

export const SHARED_PROVIDER_ENFORCED_SAFE_TOOL_NAME_SEGMENTS = [
  // Action-spec discovery tools are read-only and used by several providers before invoking actions/tools.
  // Auto-approve to avoid blocking harmless capability discovery behind provider-native permission prompts.
  'action_spec_search',
  'action_spec_get',
  'action_options_resolve',
  ...SHARED_PERMISSION_SAFE_TOOL_NAME_TOKENS,
  // ACP fs bridge operations are host-side capability calls. Reads and writes outside Read Only/Plan
  // remain auto-approved to avoid duplicating provider permission policy at the host layer.
  'readtextfile',
  'writetextfile',
  'read_text_file',
  'write_text_file',
] as const;

export const SHARED_PROVIDER_ENFORCED_SAFE_TOOL_CALL_ID_SEGMENTS = [
  'change_title',
  ...SHARED_PERMISSION_SAFE_TOOL_NAME_TOKENS,
] as const;

export function isSharedPermissionSafeToolName(toolName: string): boolean {
  const normalized = normalizePermissionToolName(toolName);
  if (!normalized) return false;
  if (isChangeTitleToolLikeName(normalized)) return true;
  return SHARED_PERMISSION_SAFE_TOOL_NAME_TOKENS.some((token) => matchesSharedPermissionToolToken(normalized, token));
}

export function isSharedHappierShellBridgeToolName(toolName: string): boolean {
  const normalized = normalizePermissionToolName(toolName);
  if (!normalized) return false;
  return normalized === 'change_title' || isSharedPermissionSafeToolName(normalized);
}

export function isPermissionGuardToolName(toolName: string): boolean {
  const normalized = normalizePermissionToolName(toolName);
  if (!normalized) return false;
  return SHARED_PERMISSION_GUARD_TOOL_NAMES.includes(normalized as typeof SHARED_PERMISSION_GUARD_TOOL_NAMES[number]);
}

export function isSharedPermissionWriteLikeToolName(toolName: string): boolean {
  const normalized = normalizePermissionToolName(toolName);
  if (!normalized) return true;
  return isDefaultWriteLikeToolName(normalized);
}
