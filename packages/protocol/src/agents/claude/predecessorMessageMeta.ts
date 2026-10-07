import {
    CLAUDE_REMOTE_DEBUG_CATEGORIES,
    CLAUDE_SETTING_SOURCES_V2,
    normalizeClaudeRemoteAdvancedOptionsJson,
    normalizeClaudeUnifiedTerminalHost,
    normalizeClaudeUnifiedTerminalResumeChoice,
} from './settingsPolicy.js';

export type ClaudePredecessorMessageMetaDefaults = Readonly<{
    claudeRemoteAgentSdkEnabled: boolean;
    claudeUnifiedTerminalEnabled: boolean;
    claudeUnifiedTerminalHost: 'auto' | 'tmux' | 'zellij' | 'herdr';
    claudeUnifiedTerminalResumeChoice: 'ask_every_time' | 'resume_from_summary' | 'resume_full_session';
    claudeRemoteSettingSourcesV2: readonly (typeof CLAUDE_SETTING_SOURCES_V2)[number][];
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
    claudeRemoteDebugCategories: readonly (typeof CLAUDE_REMOTE_DEBUG_CATEGORIES)[number][];
    claudeRemoteAdvancedOptionsJson: string;
}>;
type ClaudeSettingKey = keyof ClaudePredecessorMessageMetaDefaults;
type ClaudeSettingSourcesV2 = readonly (typeof CLAUDE_SETTING_SOURCES_V2)[number][];
type ClaudeDebugCategories = readonly (typeof CLAUDE_REMOTE_DEBUG_CATEGORIES)[number][];

/**
 * Current UI -> predecessor Claude CLI message metadata compatibility writer.
 *
 * Provenance: `remote-dev` `9b097966a35e643b51e84af987a1f30869696416`
 * writes this exact metadata family in
 * `packages/agents/src/providerSettings/definitions/claudeRemote.ts` and its
 * Claude CLI reads it through
 * `apps/cli/src/backends/claude/remote/claudeRemoteMetaState.ts`.
 *
 * This private bundled bridge exists only while a supported release or the
 * moving predecessor reads these fields from persisted outbound user-message
 * metadata. Remove it, its generated entry, and its package export once that
 * consumer frontier no longer requires the shape. It is intentionally not an
 * Agent UI behavior override or public SDK capability.
 */

function readSetting(defaults: ClaudePredecessorMessageMetaDefaults, settings: Readonly<Record<string, unknown>>, key: ClaudeSettingKey): unknown {
    const value = settings[key];
    return value === undefined ? defaults[key] : value;
}

function readBoolean(defaults: ClaudePredecessorMessageMetaDefaults, settings: Readonly<Record<string, unknown>>, key: ClaudeSettingKey): boolean {
    const value = readSetting(defaults, settings, key);
    return typeof value === 'boolean' ? value : Boolean(defaults[key]);
}

function readNumber(defaults: ClaudePredecessorMessageMetaDefaults, settings: Readonly<Record<string, unknown>>, key: ClaudeSettingKey): number {
    const value = readSetting(defaults, settings, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : Number(defaults[key]);
}

function readNullableNumber(defaults: ClaudePredecessorMessageMetaDefaults, settings: Readonly<Record<string, unknown>>, key: ClaudeSettingKey): number | null {
    const value = readSetting(defaults, settings, key);
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

export function readClaudeSettingSourcesV2(defaults: Pick<ClaudePredecessorMessageMetaDefaults, 'claudeRemoteSettingSourcesV2'>, settings: Readonly<Record<string, unknown>>): ClaudeSettingSourcesV2 {
    const parsed = readEnumArray(settings.claudeRemoteSettingSourcesV2, CLAUDE_SETTING_SOURCES_V2, 3);
    if (parsed) return parsed;
    if (typeof settings.claudeRemoteSettingSources === 'string') {
        const legacy = mapLegacyClaudeSettingSourcesToV2(settings.claudeRemoteSettingSources);
        if (legacy) return legacy;
    }
    return defaults.claudeRemoteSettingSourcesV2 as ClaudeSettingSourcesV2;
}

function readClaudeDebugCategories(defaults: ClaudePredecessorMessageMetaDefaults, settings: Readonly<Record<string, unknown>>): ClaudeDebugCategories {
    return (
        readEnumArray(settings.claudeRemoteDebugCategories, CLAUDE_REMOTE_DEBUG_CATEGORIES, 5)
        ?? defaults.claudeRemoteDebugCategories
    ) as ClaudeDebugCategories;
}

export function buildClaudePredecessorMessageMeta(
    settings: Readonly<Record<string, unknown>>,
    defaults: ClaudePredecessorMessageMetaDefaults,
): Readonly<Record<string, string | number | boolean | null | readonly string[]>> {
    const settingSourcesV2 = readClaudeSettingSourcesV2(defaults, settings);
    const legacySettingSources = tryMapSettingSourcesV2ToLegacy(settingSourcesV2);
    return {
        claudeRemoteAgentSdkEnabled: readBoolean(defaults, settings, 'claudeRemoteAgentSdkEnabled'),
        claudeUnifiedTerminalEnabled: readBoolean(defaults, settings, 'claudeUnifiedTerminalEnabled'),
        claudeUnifiedTerminalHost:
            normalizeClaudeUnifiedTerminalHost(readSetting(defaults, settings, 'claudeUnifiedTerminalHost'))
            ?? defaults.claudeUnifiedTerminalHost,
        claudeUnifiedTerminalResumeChoice:
            normalizeClaudeUnifiedTerminalResumeChoice(readSetting(defaults, settings, 'claudeUnifiedTerminalResumeChoice'))
            ?? defaults.claudeUnifiedTerminalResumeChoice,
        claudeRemoteSettingSourcesV2: settingSourcesV2,
        ...(legacySettingSources ? { claudeRemoteSettingSources: legacySettingSources } : {}),
        claudeCodeExperimentalAgentTeamsEnabled: readBoolean(defaults, settings, 'claudeCodeExperimentalAgentTeamsEnabled'),
        claudeLocalPermissionBridgeEnabled: readBoolean(defaults, settings, 'claudeLocalPermissionBridgeEnabled'),
        claudeLocalPermissionBridgeWaitIndefinitely: readBoolean(defaults, settings, 'claudeLocalPermissionBridgeWaitIndefinitely'),
        claudeLocalPermissionBridgeTimeoutSeconds: readNumber(defaults, settings, 'claudeLocalPermissionBridgeTimeoutSeconds'),
        claudeRemoteEnableFileCheckpointing: readBoolean(defaults, settings, 'claudeRemoteEnableFileCheckpointing'),
        claudeRemoteMaxThinkingTokens: readNullableNumber(defaults, settings, 'claudeRemoteMaxThinkingTokens'),
        claudeRemoteDisableTodos: readBoolean(defaults, settings, 'claudeRemoteDisableTodos'),
        claudeRemoteStrictMcpServerConfig: readBoolean(defaults, settings, 'claudeRemoteStrictMcpServerConfig'),
        claudeRemoteDebugEnabled: readBoolean(defaults, settings, 'claudeRemoteDebugEnabled'),
        claudeRemoteVerboseEnabled: readBoolean(defaults, settings, 'claudeRemoteVerboseEnabled'),
        claudeRemoteDebugCategories: readClaudeDebugCategories(defaults, settings),
        claudeRemoteAdvancedOptionsJson: normalizeClaudeRemoteAdvancedOptionsJson(
            readSetting(defaults, settings, 'claudeRemoteAdvancedOptionsJson'),
        ),
    };
}
