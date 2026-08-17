import type { PiPermissionMode } from './types.js';

const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
const SAFE_WRITE_TOOLS = ['read', 'edit', 'write', 'grep', 'find', 'ls'] as const;

type PiPermissionIntent = 'default' | 'read-only' | 'safe-yolo' | 'yolo' | 'plan';

export type PiPermissionModeResolutionV1 = Readonly<{
  // `null` preserves Pi's native catalog, including extension/custom tools.
  tools: readonly string[] | null;
  resolvedIntent: PiPermissionIntent;
  diagnostic: Readonly<{
    kind: 'unknown_permission_mode';
    requestedMode: string;
    appliedIntent: 'read-only';
  }> | null;
}>;

function normalizePermissionMode(permissionMode?: PiPermissionMode): PiPermissionIntent | null {
  const rawMode = typeof permissionMode === 'string' ? permissionMode.trim() : '';
  if (!rawMode) return 'default';
  if (rawMode === 'acceptEdits') return 'safe-yolo';
  if (rawMode === 'bypassPermissions') return 'yolo';
  if (
    rawMode === 'default'
    || rawMode === 'read-only'
    || rawMode === 'safe-yolo'
    || rawMode === 'yolo'
    || rawMode === 'plan'
  ) {
    return rawMode;
  }
  return null;
}

function toolsForIntent(intent: PiPermissionIntent): readonly string[] | null {
  if (intent === 'plan' || intent === 'read-only') return READ_ONLY_TOOLS;
  if (intent === 'safe-yolo') return SAFE_WRITE_TOOLS;
  return null;
}

// Restricted Pi permissions are launch-time-only via the tools allowlist.
// There is no mid-session ask/respond flow, so unrecognized modes must resolve
// read-only instead of inheriting Pi's unrestricted native tool catalog.
export function resolvePiToolsForPermissionMode(permissionMode?: PiPermissionMode): PiPermissionModeResolutionV1 {
  const resolvedIntent = normalizePermissionMode(permissionMode);
  if (resolvedIntent) {
    return { tools: toolsForIntent(resolvedIntent), resolvedIntent, diagnostic: null };
  }
  return {
    tools: READ_ONLY_TOOLS,
    resolvedIntent: 'read-only',
    diagnostic: {
      kind: 'unknown_permission_mode',
      requestedMode: typeof permissionMode === 'string' ? permissionMode : String(permissionMode),
      appliedIntent: 'read-only',
    },
  };
}

export function buildPiToolsForPermissionMode(permissionMode?: PiPermissionMode): readonly string[] | null {
  return resolvePiToolsForPermissionMode(permissionMode).tools;
}
