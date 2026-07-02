export interface SessionHookData {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    transcriptPath?: string;
    cwd?: string;
    hook_event_name?: string;
    hookEventName?: string;
    source?: string;
    [key: string]: unknown;
}

export interface PermissionHookData {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    transcriptPath?: string;
    cwd?: string;
    hook_event_name?: string;
    hookEventName?: string;
    permission_mode?: string;
    permissionMode?: string;
    tool_name?: string;
    toolName?: string;
    tool_input?: unknown;
    toolInput?: unknown;
    tool_use_id?: string;
    toolUseId?: string;
    [key: string]: unknown;
}

export interface PermissionHookResponse {
    continue: boolean;
    suppressOutput?: boolean;
    stopReason?: string;
    systemMessage?: string;
    hookSpecificOutput?: {
        hookEventName?: 'PermissionRequest' | 'PreToolUse';
        decision?: {
            behavior: 'allow' | 'deny';
            message?: string;
            interrupt?: boolean;
            updatedInput?: unknown;
            updatedPermissions?: unknown;
        };
        permissionDecision?: 'allow' | 'ask' | 'deny';
        updatedInput?: unknown;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export function readPermissionHookEventName(data: PermissionHookData): 'PermissionRequest' | 'PreToolUse' {
    const hookEventName = data.hook_event_name || data.hookEventName;
    return hookEventName === 'PreToolUse' ? 'PreToolUse' : 'PermissionRequest';
}

export function buildDefaultPermissionHookResponse(data: PermissionHookData = {}): PermissionHookResponse {
    return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: { hookEventName: readPermissionHookEventName(data) },
    };
}

