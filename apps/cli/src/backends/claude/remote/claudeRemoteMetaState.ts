export type ClaudeRemoteMetaState = Readonly<{
    claudeRemoteAgentSdkEnabled: boolean;
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
    claudeRemoteIncludePartialMessages: boolean;
    claudeCodeExperimentalAgentTeamsEnabled: boolean;
    claudeLocalPermissionBridgeEnabled: boolean;
    claudeLocalPermissionBridgeWaitIndefinitely: boolean;
    claudeLocalPermissionBridgeTimeoutSeconds: number;
    claudeRemoteEnableFileCheckpointing: boolean;
    claudeRemoteMaxThinkingTokens: number | null;
    claudeRemoteDisableTodos: boolean;
    claudeRemoteStrictMcpServerConfig: boolean;
    claudeRemoteAdvancedOptionsJson: string;
}>;

const SETTING_SOURCES_V2_ORDER = ['user', 'project', 'local'] as const;

function normalizeSettingSourcesV2(raw: unknown): ('user' | 'project' | 'local')[] | null {
    if (!Array.isArray(raw)) return null;
    const set = new Set<string>();
    for (const value of raw) {
        if (typeof value !== 'string') continue;
        set.add(value);
    }
    const out: ('user' | 'project' | 'local')[] = [];
    for (const key of SETTING_SOURCES_V2_ORDER) {
        if (set.has(key)) out.push(key);
    }
    return out;
}

export const DEFAULT_CLAUDE_REMOTE_META_STATE: ClaudeRemoteMetaState = Object.freeze({
    claudeRemoteAgentSdkEnabled: true,
    claudeRemoteSettingSourcesV2: ['user', 'project', 'local'] as const,
    // Default to loading BOTH user + project settings so Claude Code can see the user's
    // globally configured MCP servers (and other preferences) when launched by Happier.
    claudeRemoteSettingSources: 'user_project',
    claudeRemoteIncludePartialMessages: false,
    claudeCodeExperimentalAgentTeamsEnabled: false,
    claudeLocalPermissionBridgeEnabled: true,
    claudeLocalPermissionBridgeWaitIndefinitely: false,
    claudeLocalPermissionBridgeTimeoutSeconds: 600,
    claudeRemoteEnableFileCheckpointing: false,
    claudeRemoteMaxThinkingTokens: null,
    claudeRemoteDisableTodos: false,
    claudeRemoteStrictMcpServerConfig: false,
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

    if (typeof record.claudeRemoteAgentSdkEnabled === 'boolean') {
        next.claudeRemoteAgentSdkEnabled = record.claudeRemoteAgentSdkEnabled;
    }

    const normalizedV2 = normalizeSettingSourcesV2((record as any).claudeRemoteSettingSourcesV2);
    if (normalizedV2 !== null) {
        next.claudeRemoteSettingSourcesV2 = normalizedV2;
    }

    if (typeof record.claudeRemoteSettingSources === 'string') {
        const value = record.claudeRemoteSettingSources;
        if (value === 'project' || value === 'user_project' || value === 'none') {
            next.claudeRemoteSettingSources = value;
        }
    }

    if (typeof record.claudeRemoteIncludePartialMessages === 'boolean') {
        next.claudeRemoteIncludePartialMessages = record.claudeRemoteIncludePartialMessages;
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

    if (typeof record.claudeRemoteAdvancedOptionsJson === 'string') {
        next.claudeRemoteAdvancedOptionsJson = record.claudeRemoteAdvancedOptionsJson;
    }

    return Object.freeze({ ...next });
}
