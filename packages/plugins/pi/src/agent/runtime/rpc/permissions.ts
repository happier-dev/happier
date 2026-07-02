import type { PiPermissionMode } from './types.js';

export function buildPiToolsForPermissionMode(permissionMode?: PiPermissionMode): readonly string[] {
  const rawMode = typeof permissionMode === 'string' ? permissionMode : 'default';
  const mode = rawMode === 'acceptEdits'
    ? 'safe-yolo'
    : rawMode === 'bypassPermissions'
      ? 'yolo'
      : rawMode;

  if (mode === 'plan' || mode === 'read-only') {
    return ['read', 'grep', 'find', 'ls'];
  }
  if (mode === 'safe-yolo') {
    return ['read', 'edit', 'write', 'grep', 'find', 'ls'];
  }
  return ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
}
