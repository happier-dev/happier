import { SESSION_PERMISSION_MODES } from '@happier-dev/protocol/sessions/metadata/permission-modes';

/**
 * Permission mode values include both Claude and Codex modes and match
 * MessageMetaSchema.permissionMode. Agent SDK boundaries map these spellings
 * to native permissions; the Protocol vocabulary remains authoritative.
 */
export const PERMISSION_MODES = SESSION_PERMISSION_MODES;

const CODEX_GEMINI_NON_DEFAULT_PERMISSION_MODES = ['read-only', 'safe-yolo', 'yolo'] as const;
export const CODEX_GEMINI_PERMISSION_MODES = ['default', ...CODEX_GEMINI_NON_DEFAULT_PERMISSION_MODES] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}

export type CodexGeminiPermissionMode = (typeof CODEX_GEMINI_PERMISSION_MODES)[number];

export function isCodexGeminiPermissionMode(value: PermissionMode): value is CodexGeminiPermissionMode {
  return (CODEX_GEMINI_PERMISSION_MODES as readonly string[]).includes(value);
}

// Codex also accepts bypassPermissions as an alias for full access.
export const CODEX_PERMISSION_MODES = [
  'default',
  'read-only',
  'safe-yolo',
  'yolo',
  'bypassPermissions',
] as const;

export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number];

export function isCodexPermissionMode(value: PermissionMode): value is CodexPermissionMode {
  return (CODEX_PERMISSION_MODES as readonly string[]).includes(value);
}
