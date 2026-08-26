import {
    CLAUDE_REMOTE_DEBUG_CATEGORIES,
    CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS,
    CLAUDE_SETTING_SOURCES_V2,
    normalizeClaudeRemoteAdvancedOptionsJson,
    normalizeClaudeUnifiedTerminalHost,
    normalizeClaudeUnifiedTerminalResumeChoice,
} from '../protocol/remoteSettings.js';

type ClaudeSettingKey = keyof typeof CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS;
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

function readSetting(settings: Readonly<Record<string, unknown>>, key: ClaudeSettingKey): unknown {
    const value = settings[key];
    return value === undefined ? CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS[key] : value;
}

function readBoolean(settings: Readonly<Record<string, unknown>>, key: ClaudeSettingKey): boolean {
    const value = readSetting(settings, key);
    return typeof value === 'boolean' ? value : Boolean(CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS[key]);
}

function readNumber(settings: Readonly<Record<string, unknown>>, key: ClaudeSettingKey): number {
    const value = readSetting(settings, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : Number(CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS[key]);
}

function readNullableNumber(settings: Readonly<Record<string, unknown>>, key: ClaudeSettingKey): number | null {
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

function readClaudeSettingSourcesV2(settings: Readonly<Record<string, unknown>>): ClaudeSettingSourcesV2 {
    const parsed = readEnumArray(settings.claudeRemoteSettingSourcesV2, CLAUDE_SETTING_SOURCES_V2, 3);
    if (parsed) return parsed;
    if (typeof settings.claudeRemoteSettingSources === 'string') {
        const legacy = mapLegacyClaudeSettingSourcesToV2(settings.claudeRemoteSettingSources);
        if (legacy) return legacy;
    }
    return CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeRemoteSettingSourcesV2 as ClaudeSettingSourcesV2;
}

function readClaudeDebugCategories(settings: Readonly<Record<string, unknown>>): ClaudeDebugCategories {
    return (
        readEnumArray(settings.claudeRemoteDebugCategories, CLAUDE_REMOTE_DEBUG_CATEGORIES, 5)
        ?? CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeRemoteDebugCategories
    ) as ClaudeDebugCategories;
}

export function buildClaudePredecessorMessageMeta(
    settings: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean | null | readonly string[]>> {
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
        claudeRemoteSettingSourcesV2: settingSourcesV2,
        ...(legacySettingSources ? { claudeRemoteSettingSources: legacySettingSources } : {}),
        claudeCodeExperimentalAgentTeamsEnabled: readBoolean(settings, 'claudeCodeExperimentalAgentTeamsEnabled'),
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
        claudeRemoteAdvancedOptionsJson: normalizeClaudeRemoteAdvancedOptionsJson(
            readSetting(settings, 'claudeRemoteAdvancedOptionsJson'),
        ),
    };
}

export const CLAUDE_PREDECESSOR_MESSAGE_META_WRITER = {
    buildPredecessorMessageMeta: buildClaudePredecessorMessageMeta,
} as const;
