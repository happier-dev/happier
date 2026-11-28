import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { parsePermissionIntentAlias } from '@happier-dev/plugin-sdk/agents/runtime';

import type { PiPermissionMode } from './types.js';

const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

const NO_TOOLS_REFUSAL = {
  code: 'unsupported',
  message: 'Native Pi cannot enforce the selected tool filter or policy.',
} as const;

// The native launch currently permits extensions to activate tools.
export function readPiNoToolsRefusal(configuration?: AgentSessionOpenRequest['configuration']) {
  return configuration?.unlistedTools === 'deny' && configuration.allowedTools?.length === 0
    ? NO_TOOLS_REFUSAL
    : null;
}

export function resolvePiConfiguredPermissionMode(configuration?: AgentSessionOpenRequest['configuration']): PiPermissionMode | undefined {
  return configuration?.workspaceWrites === 'deny' ? 'read-only' : configuration?.permissionIntent.value ?? undefined;
}

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
  return parsePermissionIntentAlias(rawMode);
}

function toolsForIntent(intent: PiPermissionIntent): readonly string[] | null {
  if (intent === 'plan' || intent === 'read-only') return READ_ONLY_TOOLS;
  return null;
}

export type PiEffectiveLaunchPermissionPolicy = 'read-only-tools' | 'native-catalog';

export function resolvePiEffectiveLaunchPermissionPolicy(
  permissionMode?: PiPermissionMode,
): PiEffectiveLaunchPermissionPolicy {
  return resolvePiToolsForPermissionMode(permissionMode).tools === null
    ? 'native-catalog'
    : 'read-only-tools';
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
