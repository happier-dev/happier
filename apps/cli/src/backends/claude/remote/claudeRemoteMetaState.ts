type ClaudeRemoteSettingSourceV2 = 'user' | 'project' | 'local';
type ClaudeRemoteDebugCategory = 'api' | 'mcp' | 'hooks' | 'file' | '1p';

export type ClaudeRemoteMetaState = Readonly<{
    claudeRemoteAgentSdkEnabled: boolean;
    /**
     * v2 multi-select representation of Claude Code setting sources.
     *
     * Default: ['user','project','local'] which represents "Claude default behavior" and
     * should generally NOT force an explicit override in the runner.
     */
    claudeRemoteSettingSourcesV2: readonly ClaudeRemoteSettingSourceV2[];
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
    claudeRemoteDebugCategories: readonly ClaudeRemoteDebugCategory[];
    claudeRemoteAdvancedOptionsJson: string;
}>;

const SETTING_SOURCES_V2_ORDER = ['user', 'project', 'local'] as const;
const DEBUG_CATEGORIES_ORDER = ['api', 'mcp', 'hooks', 'file', '1p'] as const;

function normalizeSettingSourcesV2(raw: unknown): ClaudeRemoteSettingSourceV2[] | null {
    if (!Array.isArray(raw)) return null;
    const set = new Set<string>();
    for (const value of raw) {
        if (typeof value !== 'string') continue;
        set.add(value);
    }
    const out: ClaudeRemoteSettingSourceV2[] = [];
    for (const key of SETTING_SOURCES_V2_ORDER) {
        if (set.has(key)) out.push(key);
    }
    return out;
}

function normalizeDebugCategories(raw: unknown): ClaudeRemoteDebugCategory[] | null {
    if (!Array.isArray(raw)) return null;
    const set = new Set<string>();
    for (const value of raw) {
        if (typeof value !== 'string') continue;
        set.add(value);
    }
    const out: ClaudeRemoteDebugCategory[] = [];
    for (const key of DEBUG_CATEGORIES_ORDER) {
        if (set.has(key)) out.push(key);
    }
    return out;
}

function mapLegacySettingSourcesToV2(raw: unknown): ClaudeRemoteSettingSourceV2[] | null {
    if (raw === 'none') return [];
    if (raw === 'project') return ['project'];
    if (raw === 'user_project') return ['user', 'project'];
    return null;
}

export const DEFAULT_CLAUDE_REMOTE_META_STATE: ClaudeRemoteMetaState = Object.freeze({
    claudeRemoteAgentSdkEnabled: true,
    claudeRemoteSettingSourcesV2: ['user', 'project', 'local'] as const,
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

    if (typeof record.claudeRemoteAgentSdkEnabled === 'boolean') {
        next.claudeRemoteAgentSdkEnabled = record.claudeRemoteAgentSdkEnabled;
    }

    const normalizedV2 = normalizeSettingSourcesV2(record.claudeRemoteSettingSourcesV2);
    if (normalizedV2 !== null) {
        next.claudeRemoteSettingSourcesV2 = normalizedV2;
    }

    if (normalizedV2 === null) {
        const legacyV2 = mapLegacySettingSourcesToV2(record.claudeRemoteSettingSources);
        if (legacyV2 !== null) {
            next.claudeRemoteSettingSourcesV2 = legacyV2;
        }
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
