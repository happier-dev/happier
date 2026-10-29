import { normalizeClaudeSettingSourcesV2 } from '@/backends/claude/utils/resolveClaudeSettingSources';
import {
    CLAUDE_UNIFIED_TERMINAL_HOSTS,
    CLAUDE_REMOTE_PROVIDER_FIELDS,
    CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
    CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
    type ClaudeUnifiedTerminalHost,
    type ClaudeUnifiedTerminalResumeChoice,
    type ClaudeUnifiedTerminalResponseLocation,
    CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS,
} from '@happier-dev/agents';

export type ClaudeRemoteMetaState = Readonly<{
    claudeRemoteAgentSdkEnabled: boolean;
    claudeRemoteIdleReclaimEnabled: boolean;
    claudeRemoteIdleReclaimTimeoutMinutes: number;
    claudeUnifiedTerminalEnabled: boolean;
    claudeUnifiedTerminalHost: ClaudeUnifiedTerminalHost;
    claudeUnifiedTerminalResumeChoice: ClaudeUnifiedTerminalResumeChoice;
    claudeUnifiedTerminalQuestionResponseLocation: ClaudeUnifiedTerminalResponseLocation | null;
    claudeUnifiedTerminalPermissionResponseLocation: ClaudeUnifiedTerminalResponseLocation | null;
    /**
     * v2 multi-select representation of Claude Code setting sources.
     *
     * Default: ['user','project','local'] which represents "Claude default behavior" and
     * should generally NOT force an explicit override in the runner.
     */
    claudeRemoteSettingSourcesV2: readonly ('user' | 'project' | 'local')[];
    /**
     * Legacy (v1) setting sources.
     *
     * Kept for back-compat with older clients. New code should prefer `claudeRemoteSettingSourcesV2`.
     */
    claudeRemoteSettingSources: 'project' | 'user_project' | 'none';
    claudeCodeIncludeInNativeHistory: boolean;
    claudeCodeExperimentalAgentTeamsEnabled: boolean;
    claudeLocalPermissionBridgeEnabled: boolean;
    claudeLocalPermissionBridgeWaitIndefinitely: boolean;
    claudeLocalPermissionBridgeTimeoutSeconds: number;
    claudeRemoteEnableFileCheckpointing: boolean;
    claudeRemoteMaxThinkingTokens: number | null;
    claudeRemoteDisableTodos: boolean;
    claudeRemoteStrictMcpServerConfig: boolean;
    claudeRemoteDebugEnabled: boolean;
    claudeRemoteVerboseEnabled: boolean;
    claudeRemoteDebugCategories: readonly ('api' | 'mcp' | 'hooks' | 'file' | '1p')[];
    claudeRemoteAdvancedOptionsJson: string;
}>;

const DEBUG_CATEGORIES_ORDER = ['api', 'mcp', 'hooks', 'file', '1p'] as const;

function isClaudeUnifiedTerminalHost(value: string): value is ClaudeUnifiedTerminalHost {
    return (CLAUDE_UNIFIED_TERMINAL_HOSTS as readonly string[]).includes(value);
}

function isClaudeUnifiedTerminalResumeChoice(value: string): value is ClaudeUnifiedTerminalResumeChoice {
    return (CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES as readonly string[]).includes(value);
}

function normalizeDebugCategories(raw: unknown): Array<'api' | 'mcp' | 'hooks' | 'file' | '1p'> | null {
    if (!Array.isArray(raw)) return null;
    const set = new Set<string>();
    for (const value of raw) {
        if (typeof value !== 'string') continue;
        set.add(value);
    }
    const out: Array<'api' | 'mcp' | 'hooks' | 'file' | '1p'> = [];
    for (const key of DEBUG_CATEGORIES_ORDER) {
        if (set.has(key)) out.push(key);
    }
    return out;
}

export const DEFAULT_CLAUDE_REMOTE_META_STATE: ClaudeRemoteMetaState = Object.freeze({
    claudeRemoteAgentSdkEnabled: true,
    claudeRemoteIdleReclaimEnabled: CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteIdleReclaimEnabled,
    claudeRemoteIdleReclaimTimeoutMinutes: CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteIdleReclaimTimeoutMinutes,
    claudeUnifiedTerminalEnabled: false,
    claudeUnifiedTerminalHost: 'auto',
    claudeUnifiedTerminalResumeChoice: 'ask_every_time',
    // Preserve absence until the shared resolver can see an older explicit bridge opt-out.
    claudeUnifiedTerminalQuestionResponseLocation: null,
    claudeUnifiedTerminalPermissionResponseLocation: null,
    claudeRemoteSettingSourcesV2: ['user', 'project', 'local'] as const,
    // Default to loading BOTH user + project settings so Claude Code can see the user's
    // globally configured MCP servers (and other preferences) when launched by Happier.
    claudeRemoteSettingSources: 'user_project',
    claudeCodeIncludeInNativeHistory: false,
    claudeCodeExperimentalAgentTeamsEnabled: false,
    claudeLocalPermissionBridgeEnabled: true,
    claudeLocalPermissionBridgeWaitIndefinitely: true,
    claudeLocalPermissionBridgeTimeoutSeconds: 600,
    claudeRemoteEnableFileCheckpointing: false,
    claudeRemoteMaxThinkingTokens: null,
    claudeRemoteDisableTodos: false,
    claudeRemoteStrictMcpServerConfig: false,
    claudeRemoteDebugEnabled: false,
    claudeRemoteVerboseEnabled: false,
    claudeRemoteDebugCategories: [] as const,
    claudeRemoteAdvancedOptionsJson: '',
});

export function applyClaudeRemoteMetaState(prev: ClaudeRemoteMetaState, meta: unknown): ClaudeRemoteMetaState {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return prev;

    type MutableClaudeRemoteMetaState = {
        -readonly [K in keyof ClaudeRemoteMetaState]: ClaudeRemoteMetaState[K];
    };

    const next: MutableClaudeRemoteMetaState = {
        ...prev,
    };

    const record = meta as Record<string, unknown>;
    for (const key of ['claudeUnifiedTerminalQuestionResponseLocation', 'claudeUnifiedTerminalPermissionResponseLocation'] as const) {
        const value = record[key];
        if (typeof value === 'string' && (CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS as readonly string[]).includes(value)) {
            next[key] = value as ClaudeUnifiedTerminalResponseLocation;
        }
    }

    if (typeof record.claudeRemoteAgentSdkEnabled === 'boolean') {
        next.claudeRemoteAgentSdkEnabled = record.claudeRemoteAgentSdkEnabled;
    }

    if (typeof record.claudeRemoteIdleReclaimEnabled === 'boolean') {
        next.claudeRemoteIdleReclaimEnabled = record.claudeRemoteIdleReclaimEnabled;
    }
    const idleTimeout = CLAUDE_REMOTE_PROVIDER_FIELDS.claudeRemoteIdleReclaimTimeoutMinutes.schema.safeParse(
        record.claudeRemoteIdleReclaimTimeoutMinutes,
    );
    if (idleTimeout.success) {
        next.claudeRemoteIdleReclaimTimeoutMinutes = idleTimeout.data;
    }

    if (typeof record.claudeUnifiedTerminalEnabled === 'boolean') {
        next.claudeUnifiedTerminalEnabled = record.claudeUnifiedTerminalEnabled;
    }

    if (typeof record.claudeUnifiedTerminalHost === 'string') {
        const value = record.claudeUnifiedTerminalHost;
        if (isClaudeUnifiedTerminalHost(value)) {
            next.claudeUnifiedTerminalHost = value;
        }
    }

    if (typeof record.claudeUnifiedTerminalResumeChoice === 'string') {
        const value = record.claudeUnifiedTerminalResumeChoice;
        if (isClaudeUnifiedTerminalResumeChoice(value)) {
            next.claudeUnifiedTerminalResumeChoice = value;
        }
    }

    const normalizedV2 = normalizeClaudeSettingSourcesV2(record.claudeRemoteSettingSourcesV2);
    if (normalizedV2 !== null) {
        next.claudeRemoteSettingSourcesV2 = normalizedV2;
    }

    if (typeof record.claudeRemoteSettingSources === 'string') {
        const value = record.claudeRemoteSettingSources;
        if (value === 'project' || value === 'user_project' || value === 'none') {
            next.claudeRemoteSettingSources = value;
        }
    }

    if (typeof record.claudeCodeIncludeInNativeHistory === 'boolean') {
        next.claudeCodeIncludeInNativeHistory = record.claudeCodeIncludeInNativeHistory;
    }

    if (typeof record.claudeCodeExperimentalAgentTeamsEnabled === 'boolean') {
        next.claudeCodeExperimentalAgentTeamsEnabled = record.claudeCodeExperimentalAgentTeamsEnabled;
    }

    if (typeof record.claudeLocalPermissionBridgeEnabled === 'boolean') {
        next.claudeLocalPermissionBridgeEnabled = record.claudeLocalPermissionBridgeEnabled;
    }

    if (typeof record.claudeLocalPermissionBridgeWaitIndefinitely === 'boolean') {
        next.claudeLocalPermissionBridgeWaitIndefinitely = record.claudeLocalPermissionBridgeWaitIndefinitely;
    }

    if (
        typeof record.claudeLocalPermissionBridgeTimeoutSeconds === 'number'
        && Number.isFinite(record.claudeLocalPermissionBridgeTimeoutSeconds)
        && record.claudeLocalPermissionBridgeTimeoutSeconds > 0
        && Number.isInteger(record.claudeLocalPermissionBridgeTimeoutSeconds)
    ) {
        next.claudeLocalPermissionBridgeTimeoutSeconds = record.claudeLocalPermissionBridgeTimeoutSeconds;
    }

    if (typeof record.claudeRemoteEnableFileCheckpointing === 'boolean') {
        next.claudeRemoteEnableFileCheckpointing = record.claudeRemoteEnableFileCheckpointing;
    }

    if (record.claudeRemoteMaxThinkingTokens === null) {
        next.claudeRemoteMaxThinkingTokens = null;
    } else if (
        typeof record.claudeRemoteMaxThinkingTokens === 'number'
        && Number.isFinite(record.claudeRemoteMaxThinkingTokens)
        && record.claudeRemoteMaxThinkingTokens >= 0
        && Number.isInteger(record.claudeRemoteMaxThinkingTokens)
    ) {
        next.claudeRemoteMaxThinkingTokens = record.claudeRemoteMaxThinkingTokens;
    }

    if (typeof record.claudeRemoteDisableTodos === 'boolean') {
        next.claudeRemoteDisableTodos = record.claudeRemoteDisableTodos;
    }

    if (typeof record.claudeRemoteStrictMcpServerConfig === 'boolean') {
        next.claudeRemoteStrictMcpServerConfig = record.claudeRemoteStrictMcpServerConfig;
    }

    if (typeof record.claudeRemoteDebugEnabled === 'boolean') {
        next.claudeRemoteDebugEnabled = record.claudeRemoteDebugEnabled;
    }

    if (typeof record.claudeRemoteVerboseEnabled === 'boolean') {
        next.claudeRemoteVerboseEnabled = record.claudeRemoteVerboseEnabled;
    }

    const normalizedDebugCategories = normalizeDebugCategories(record.claudeRemoteDebugCategories);
    if (normalizedDebugCategories !== null) {
        next.claudeRemoteDebugCategories = normalizedDebugCategories;
    }

    if (typeof record.claudeRemoteAdvancedOptionsJson === 'string') {
        next.claudeRemoteAdvancedOptionsJson = record.claudeRemoteAdvancedOptionsJson;
    }

    return Object.freeze({ ...next });
}
