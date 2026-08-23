import {
    CLAUDE_REMOTE_DEBUG_CATEGORIES,
    CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS,
    CLAUDE_SETTING_SOURCES_V2,
    normalizeClaudeUnifiedTerminalHost,
    normalizeClaudeUnifiedTerminalResumeChoice,
    normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy,
} from '../protocol/remoteSettings.js';

type ClaudeSettingKey = keyof typeof CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS;
type ClaudeSettingSourcesV2 = readonly (typeof CLAUDE_SETTING_SOURCES_V2)[number][];
type ClaudeDebugCategories = readonly (typeof CLAUDE_REMOTE_DEBUG_CATEGORIES)[number][];

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readSetting(settings: Record<string, unknown>, key: ClaudeSettingKey): unknown {
    const value = settings[key];
    if (value === undefined) return CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS[key];
    return value;
}

function readBoolean(settings: Record<string, unknown>, key: ClaudeSettingKey): boolean {
    const value = readSetting(settings, key);
    return typeof value === 'boolean' ? value : Boolean(CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS[key]);
}

function readNumber(settings: Record<string, unknown>, key: ClaudeSettingKey): number {
    const value = readSetting(settings, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : Number(CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS[key]);
}

function readNullableNumber(settings: Record<string, unknown>, key: ClaudeSettingKey): number | null {
    const value = readSetting(settings, key);
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function mapLegacyClaudeSettingSourcesToV2(value: string): ClaudeSettingSourcesV2 | null {
    if (value === 'none') return [];
    if (value === 'project') return ['project'];
    if (value === 'user_project') return ['user', 'project'];
    return null;
}

function tryMapSettingSourcesV2ToLegacy(value: ClaudeSettingSourcesV2): 'project' | 'user_project' | 'none' | null {
    if (value.length === 0) return 'none';
    if (value.length === 1 && value[0] === 'project') return 'project';
    if (value.length === 2 && value[0] === 'user' && value[1] === 'project') return 'user_project';
    return null;
}

function readEnumArray<TValue extends string>(
    value: unknown,
    allowedValues: readonly TValue[],
    max: number,
): readonly TValue[] | null {
    if (!Array.isArray(value) || value.length > max) return null;
    const allowed = new Set<string>(allowedValues);
    const out: TValue[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string' || !allowed.has(entry)) return null;
        out.push(entry as TValue);
    }
    return out;
}

function readClaudeSettingSourcesV2(settings: Record<string, unknown>): ClaudeSettingSourcesV2 {
    const parsed = readEnumArray(settings.claudeRemoteSettingSourcesV2, CLAUDE_SETTING_SOURCES_V2, 3);
    if (parsed) return parsed;
    if (typeof settings.claudeRemoteSettingSources === 'string') {
        const legacy = mapLegacyClaudeSettingSourcesToV2(settings.claudeRemoteSettingSources);
        if (legacy) return legacy;
    }
    return CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeRemoteSettingSourcesV2 as ClaudeSettingSourcesV2;
}

function readClaudeDebugCategories(settings: Record<string, unknown>): ClaudeDebugCategories {
    return (
        readEnumArray(settings.claudeRemoteDebugCategories, CLAUDE_REMOTE_DEBUG_CATEGORIES, 5)
        ?? CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeRemoteDebugCategories
    ) as ClaudeDebugCategories;
}

function buildClaudeUiSettingsMessageMeta(settings: Record<string, unknown>): Record<string, unknown> {
    const settingSourcesV2 = readClaudeSettingSourcesV2(settings);
    const legacySettingSources = tryMapSettingSourcesV2ToLegacy(settingSourcesV2);
    return {
        claudeRemoteAgentSdkEnabled: readBoolean(settings, 'claudeRemoteAgentSdkEnabled'),
        claudeUnifiedTerminalEnabled: readBoolean(settings, 'claudeUnifiedTerminalEnabled'),
        claudeUnifiedTerminalHost:
            normalizeClaudeUnifiedTerminalHost(readSetting(settings, 'claudeUnifiedTerminalHost'))
            ?? CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeUnifiedTerminalHost,
        claudeUnifiedTerminalResumeChoice:
            normalizeClaudeUnifiedTerminalResumeChoice(readSetting(settings, 'claudeUnifiedTerminalResumeChoice'))
            ?? CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeUnifiedTerminalResumeChoice,
        claudeUnifiedTerminalWorkspaceTrust:
            normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(readSetting(settings, 'claudeUnifiedTerminalWorkspaceTrust'))
            ?? CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeUnifiedTerminalWorkspaceTrust,
        claudeRemoteSettingSourcesV2: settingSourcesV2,
        ...(legacySettingSources ? { claudeRemoteSettingSources: legacySettingSources } : {}),
        claudeLocalPermissionBridgeEnabled: readBoolean(settings, 'claudeLocalPermissionBridgeEnabled'),
        claudeLocalPermissionBridgeWaitIndefinitely: readBoolean(settings, 'claudeLocalPermissionBridgeWaitIndefinitely'),
        claudeLocalPermissionBridgeTimeoutSeconds: readNumber(settings, 'claudeLocalPermissionBridgeTimeoutSeconds'),
        claudeRemoteEnableFileCheckpointing: readBoolean(settings, 'claudeRemoteEnableFileCheckpointing'),
        claudeRemoteMaxThinkingTokens: readNullableNumber(settings, 'claudeRemoteMaxThinkingTokens'),
        claudeRemoteDisableTodos: readBoolean(settings, 'claudeRemoteDisableTodos'),
        claudeRemoteStrictMcpServerConfig: readBoolean(settings, 'claudeRemoteStrictMcpServerConfig'),
        claudeRemoteDebugEnabled: readBoolean(settings, 'claudeRemoteDebugEnabled'),
        claudeRemoteVerboseEnabled: readBoolean(settings, 'claudeRemoteVerboseEnabled'),
        claudeRemoteDebugCategories: readClaudeDebugCategories(settings),
    };
}

function canPersistMessageMetaValue(value: unknown): boolean {
    return typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean'
        || value === null
        || (
            Array.isArray(value)
            && value.length <= 16
            && value.every((entry) => typeof entry === 'string')
        );
}

function mergeProviderExtras(
    metaOverrides: Record<string, unknown> | undefined,
    extras: Record<string, unknown>,
): Record<string, unknown> | undefined {
    const merged = isRecord(metaOverrides) ? { ...metaOverrides } : {};
    for (const [key, value] of Object.entries(extras)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (Object.prototype.hasOwnProperty.call(merged, key)) continue;
        if (!canPersistMessageMetaValue(value)) continue;
        merged[key] = value;
    }
    return Object.keys(merged).length > 0 ? merged : metaOverrides;
}

export const CLAUDE_UI_BEHAVIOR_OVERRIDE = {
    message: {
        buildOverrides: ({
            settings,
            metaOverrides,
        }: {
            settings?: Record<string, unknown>;
            metaOverrides?: Record<string, unknown>;
        }) => mergeProviderExtras(
            metaOverrides,
            buildClaudeUiSettingsMessageMeta(isRecord(settings) ? settings : {}),
        ),
    },
} as const;
