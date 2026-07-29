import type { ClaudeRemoteAdvancedOptions } from '../../protocol/remoteSettings.js';

export interface SDKMessage {
    type: string;
    [key: string]: unknown;
}

export interface SDKUserMessage extends SDKMessage {
    type: 'user';
    parent_tool_use_id?: string | null;
    message: {
        role: 'user';
        content: string | Array<{
            type: string;
            text?: string;
            tool_use_id?: string;
            content?: unknown;
            [key: string]: unknown;
        }>;
    };
}

export interface SDKAssistantMessage extends SDKMessage {
    type: 'assistant';
    parent_tool_use_id?: string | null;
    message: {
        role: 'assistant';
        content: Array<{
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: unknown;
            [key: string]: unknown;
        }>;
    };
}

export interface SDKSystemMessage extends SDKMessage {
    type: 'system';
    subtype: string;
    session_id?: string;
    model?: string;
    cwd?: string;
    tools?: string[];
    slash_commands?: string[];
}

export interface SDKHookResponseMessage extends SDKSystemMessage {
    type: 'system';
    subtype: 'hook_response';
    outcome: 'success' | 'error' | 'cancelled';
    hook_event?: string;
    hook_name?: string;
    exit_code?: number;
    output?: string;
    stdout?: string;
    stderr?: string;
    uuid?: string;
    session_id?: string;
}

export interface SDKResultMessage extends SDKMessage {
    type: 'result';
    subtype: 'success' | 'error_max_turns' | 'error_during_execution';
    result?: string;
    num_turns: number;
    total_cost_usd: number;
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    session_id: string;
}

export type PermissionResult =
    | {
        behavior: 'allow';
        updatedInput: Record<string, unknown>;
        updatedPermissions?: unknown;
    }
    | {
        behavior: 'deny';
        message: string;
        interrupt?: boolean;
    };

export interface CanCallToolCallback {
    (toolName: string, input: unknown, options: {
        requestId?: string;
        signal: AbortSignal;
    }): Promise<PermissionResult>;
}

export interface GetOAuthTokenCallback {
    (options: { signal: AbortSignal }): Promise<string | null>;
}

export type QueryPrompt = string | AsyncIterable<SDKMessage>;

export interface QueryOptions extends ClaudeRemoteAdvancedOptions {
    abort?: AbortSignal;
    appendSystemPrompt?: string;
    customSystemPrompt?: string;
    cwd?: string;
    effort?: string;
    env?: Readonly<Record<string, string>>;
    extraArgs?: readonly string[];
    fallbackModel?: string;
    maxTurns?: number;
    model?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
    continue?: boolean;
    resume?: string;
    strictMcpConfig?: boolean;
    canCallTool?: CanCallToolCallback;
    getOAuthToken?: GetOAuthTokenCallback;
    settingsPath?: string;
    /**
     * Inline JSON for the single `--settings` overlay (e.g. `'{"ultracode":true}'`).
     * Claude Code keeps only the FIRST `--settings`; an explicit `settingsPath` wins.
     */
    settingsJson?: string;
}

export class AbortError extends Error {
    constructor(message = 'Claude Code process aborted by user') {
        super(message);
        this.name = 'AbortError';
    }
}
