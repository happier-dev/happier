import type { QueryOptions } from '@/backends/claude/sdk';
import type { PermissionMode } from '@/api/types';

/** Derived from SDK's QueryOptions - the modes Claude actually supports */
export type ClaudeSdkPermissionMode = NonNullable<QueryOptions['permissionMode']>;

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
    const codexToClaudeMap: Record<string, ClaudeSdkPermissionMode> = {
        'yolo': 'bypassPermissions',
        'safe-yolo': 'auto',
        'read-only': 'dontAsk',
    };
    return codexToClaudeMap[mode] ?? (mode as ClaudeSdkPermissionMode);
}

export function resolveClaudeSdkPermissionModeFromEnhancedMode(mode: {
    permissionMode: PermissionMode;
    agentModeId?: string | null | undefined;
}): ClaudeSdkPermissionMode {
    const agentModeId = typeof mode.agentModeId === 'string' ? mode.agentModeId.trim() : '';
    if (agentModeId === 'plan') return 'plan';
    return mapToClaudeMode(mode.permissionMode);
}
