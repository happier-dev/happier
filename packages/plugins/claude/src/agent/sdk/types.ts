import type { ClaudeSettingSourceV2 } from '@happier-dev/protocol/agents/claude/settings-policy';
import type { AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ClaudeRemoteAdvancedOptions } from '../../protocol/remoteSettings.js';

export interface SDKMessage {
    type: string;
    [key: string]: unknown;
}

export interface SDKUserMessage extends SDKMessage {
    type: 'user';
    uuid?: string;
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
        id?: string;
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
        agentId?: string;
        signal: AbortSignal;
    }): Promise<PermissionResult>;
}

export interface GetOAuthTokenCallback {
    (options: { signal: AbortSignal }): Promise<string | null>;
}

export type QueryPrompt = string | AsyncIterable<SDKMessage>;

export interface QueryOptions extends ClaudeRemoteAdvancedOptions {
    allowedTools?: readonly string[];
    unlistedTools?: 'ask' | 'deny';
    abort?: AbortSignal;
    allowDangerouslySkipPermissions?: boolean;
    appendSystemPrompt?: string;
    /** Installed Claude native startup transport; never puts this text in argv. */
    appendSystemPromptFile?: boolean;
    customSystemPrompt?: string;
    cwd?: string;
    effort?: string;
    env?: Readonly<Record<string, string>>;
    skills?: AgentSessionSkillDelivery;
    extraArgs?: readonly string[];
    fallbackModel?: string;
    maxTurns?: number;
    model?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
    continue?: boolean;
    resume?: string;
    strictMcpConfig?: boolean;
    settingSources?: readonly ClaudeSettingSourceV2[];
    canCallTool?: CanCallToolCallback;
    getOAuthToken?: GetOAuthTokenCallback;
    /** Native lifecycle observation on the owned child's stdio control channel. */
    onSessionHook?: (input: Readonly<Record<string, unknown>>, options: Readonly<{ signal: AbortSignal }>) => Promise<void>;
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
