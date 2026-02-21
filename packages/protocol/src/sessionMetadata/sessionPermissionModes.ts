import { z } from 'zod';

export const SESSION_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'read-only',
  'safe-yolo',
  'yolo',
] as const;

export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

/**
 * Parse behavior:
 * - Known values parse as-is.
 * - Unknown/invalid values parse as `'default'` (forward compatible; never throws).
 */
export function createSessionPermissionModeSchema(zod: typeof z) {
  return zod.enum(SESSION_PERMISSION_MODES).catch('default');
}

export const SessionPermissionModeSchema = createSessionPermissionModeSchema(z);

