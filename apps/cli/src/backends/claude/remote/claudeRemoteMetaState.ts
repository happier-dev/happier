export type ClaudeRemoteMetaState = Readonly<{
    claudeRemoteAgentSdkEnabled: boolean;
    claudeRemoteSettingSources: 'project' | 'user_project' | 'none';
    claudeRemoteIncludePartialMessages: boolean;
    claudeLocalPermissionBridgeEnabled: boolean;
    claudeLocalPermissionBridgeWaitIndefinitely: boolean;
    claudeLocalPermissionBridgeTimeoutSeconds: number;
    claudeRemoteEnableFileCheckpointing: boolean;
    claudeRemoteMaxThinkingTokens: number | null;
    claudeRemoteDisableTodos: boolean;
    claudeRemoteStrictMcpServerConfig: boolean;
    claudeRemoteAdvancedOptionsJson: string;
}>;

export const DEFAULT_CLAUDE_REMOTE_META_STATE: ClaudeRemoteMetaState = Object.freeze({
    claudeRemoteAgentSdkEnabled: true,
    claudeRemoteSettingSources: 'project',
    claudeRemoteIncludePartialMessages: false,
    claudeLocalPermissionBridgeEnabled: false,
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

    if (typeof record.claudeRemoteSettingSources === 'string') {
        const value = record.claudeRemoteSettingSources;
        if (value === 'project' || value === 'user_project' || value === 'none') {
            next.claudeRemoteSettingSources = value;
        }
    }

    if (typeof record.claudeRemoteIncludePartialMessages === 'boolean') {
        next.claudeRemoteIncludePartialMessages = record.claudeRemoteIncludePartialMessages;
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
