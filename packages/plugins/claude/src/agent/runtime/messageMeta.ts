import {
    CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
    normalizeClaudeRemoteAdvancedOptionsJson,
    normalizeClaudeUnifiedTerminalHost,
} from '@happier-dev/agents';

const CLAUDE_SETTING_SOURCES_V2 = ['user', 'project', 'local'] as const;
type ClaudeSettingSourceV2 = typeof CLAUDE_SETTING_SOURCES_V2[number];

const CLAUDE_REMOTE_DEBUG_CATEGORIES = ['api', 'mcp', 'hooks', 'file', '1p'] as const;
type ClaudeRemoteDebugCategory = typeof CLAUDE_REMOTE_DEBUG_CATEGORIES[number];

function normalizeClaudeSettingSourcesV2(raw: unknown): ClaudeSettingSourceV2[] | null {
    if (!Array.isArray(raw)) return null;
    const input = raw as unknown[];
    const inputSet = new Set(input.filter((v): v is ClaudeSettingSourceV2 => typeof v === 'string' && (CLAUDE_SETTING_SOURCES_V2 as readonly string[]).includes(v)));
    const out: ClaudeSettingSourceV2[] = [];
    for (const key of CLAUDE_SETTING_SOURCES_V2) {
        if (inputSet.has(key)) out.push(key);
    }
    return out;
}

function normalizeClaudeRemoteDebugCategories(raw: unknown): ClaudeRemoteDebugCategory[] | null {
    if (!Array.isArray(raw)) return null;
    const input = raw as unknown[];
    const inputSet = new Set(
        input.filter(
            (v): v is ClaudeRemoteDebugCategory =>
                typeof v === 'string' && (CLAUDE_REMOTE_DEBUG_CATEGORIES as readonly string[]).includes(v),
        ),
    );
    const out: ClaudeRemoteDebugCategory[] = [];
    for (const key of CLAUDE_REMOTE_DEBUG_CATEGORIES) {
        if (inputSet.has(key)) out.push(key);
    }
    return out;
}

function mapLegacyClaudeSettingSourcesToV2(value: string): ClaudeSettingSourceV2[] | null {
    if (value === 'none') return [];
    if (value === 'project') return ['project'];
    if (value === 'user_project') return ['user', 'project'];
    return null;
}

function tryMapSettingSourcesV2ToLegacy(value: readonly ClaudeSettingSourceV2[]): 'project' | 'user_project' | 'none' | null {
    if (value.length === 0) return 'none';
    if (value.length === 1 && value[0] === 'project') return 'project';
    if (value.length === 2 && value[0] === 'user' && value[1] === 'project') return 'user_project';
    return null;
}

export function buildClaudeRemoteOutgoingMessageMetaExtras(settings: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const readBoolean = <T extends keyof typeof CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS>(key: T): boolean => {
        const value = settings[key as string];
        return typeof value === 'boolean' ? value : Boolean(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS[key]);
    };

    const readNumber = <T extends keyof typeof CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS>(key: T): number => {
        const value = settings[key as string];
        return typeof value === 'number' ? value : Number(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS[key]);
    };

    const normalizedV2 = normalizeClaudeSettingSourcesV2(settings.claudeRemoteSettingSourcesV2);
    const normalizedLegacy =
        typeof settings.claudeRemoteSettingSources === 'string'
            ? (mapLegacyClaudeSettingSourcesToV2(settings.claudeRemoteSettingSources) ? settings.claudeRemoteSettingSources : null)
            : null;
    const effectiveV2 =
        normalizedV2 !== null
            ? normalizedV2
            : normalizedLegacy
                ? (mapLegacyClaudeSettingSourcesToV2(normalizedLegacy)
                    ?? CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteSettingSourcesV2 as readonly ClaudeSettingSourceV2[])
                : CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteSettingSourcesV2 as readonly ClaudeSettingSourceV2[];
    const legacyFromV2 = tryMapSettingSourcesV2ToLegacy(effectiveV2);

    const debugCategories =
        normalizeClaudeRemoteDebugCategories(settings.claudeRemoteDebugCategories)
        ?? CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteDebugCategories as readonly ClaudeRemoteDebugCategory[];

    return {
        claudeRemoteAgentSdkEnabled: readBoolean('claudeRemoteAgentSdkEnabled'),
        claudeUnifiedTerminalEnabled: readBoolean('claudeUnifiedTerminalEnabled'),
        claudeUnifiedTerminalHost:
            normalizeClaudeUnifiedTerminalHost(settings.claudeUnifiedTerminalHost)
            ?? CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeUnifiedTerminalHost,
        claudeRemoteSettingSourcesV2: effectiveV2,
        ...(legacyFromV2 ? { claudeRemoteSettingSources: legacyFromV2 } : {}),
        claudeCodeExperimentalAgentTeamsEnabled: readBoolean('claudeCodeExperimentalAgentTeamsEnabled'),
        claudeLocalPermissionBridgeEnabled: readBoolean('claudeLocalPermissionBridgeEnabled'),
        claudeLocalPermissionBridgeWaitIndefinitely: readBoolean('claudeLocalPermissionBridgeWaitIndefinitely'),
        claudeLocalPermissionBridgeTimeoutSeconds: readNumber('claudeLocalPermissionBridgeTimeoutSeconds'),
        claudeRemoteEnableFileCheckpointing: readBoolean('claudeRemoteEnableFileCheckpointing'),
        claudeRemoteMaxThinkingTokens: typeof settings.claudeRemoteMaxThinkingTokens === 'number' ? settings.claudeRemoteMaxThinkingTokens : null,
        claudeRemoteDisableTodos: readBoolean('claudeRemoteDisableTodos'),
        claudeRemoteStrictMcpServerConfig: readBoolean('claudeRemoteStrictMcpServerConfig'),
        claudeRemoteDebugEnabled: readBoolean('claudeRemoteDebugEnabled'),
        claudeRemoteVerboseEnabled: readBoolean('claudeRemoteVerboseEnabled'),
        claudeRemoteDebugCategories: debugCategories,
        claudeRemoteAdvancedOptionsJson: normalizeClaudeRemoteAdvancedOptionsJson(settings.claudeRemoteAdvancedOptionsJson),
    };
}
