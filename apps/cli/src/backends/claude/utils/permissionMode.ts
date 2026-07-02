import type { PermissionMode } from '@/api/types';
import {
    type ClaudeProviderPermissionMode as ClaudeSdkPermissionMode,
    mapToClaudePermissionMode,
    resolveClaudePermissionModeFromRuntimeMode as resolveClaudeSdkPermissionModeFromRuntimeMode,
} from '@happier-dev/plugins-claude/agent/runtime/permissionMode';

export type { ClaudeSdkPermissionMode };

export function normalizeClaudeHappyCliSessionControlPermissionMode(mode: string): string {
    if (mode === 'yolo') return 'bypassPermissions';
    if (mode === 'safe-yolo') return 'acceptEdits';
    return mode;
}

/**
 * Map any PermissionMode (7 modes) to a Claude-compatible mode (6 modes)
 * This is the ONLY place where Codex modes are mapped to Claude equivalents.
 *
 * Mapping:
 * - yolo → bypassPermissions (both skip all permissions)
 * - safe-yolo → auto (Claude's conservative auto-approve mode)
 * - read-only → dontAsk
 *
 * Claude modes pass through unchanged:
 * - default, acceptEdits, bypassPermissions, plan, dontAsk, auto
 */
export function mapToClaudeMode(mode: PermissionMode): ClaudeSdkPermissionMode {
    return mapToClaudePermissionMode(mode);
}

export function resolveClaudeSdkPermissionModeFromEnhancedMode(mode: {
    permissionMode: PermissionMode;
    agentModeId?: string | null | undefined;
}): ClaudeSdkPermissionMode {
    return resolveClaudeSdkPermissionModeFromRuntimeMode(mode);
}
