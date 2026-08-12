import { hashObject } from '@/utils/deterministicJson';

import type { EnhancedMode } from '@/backends/claude/loop';
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from '@/backends/claude/utils/permissionMode';
import {
    resolveClaudeEffortForModel,
    resolveClaudeUltracodeForModel,
    resolveModeEffortLevelsForModel,
} from '@/backends/claude/utils/claudeEffort';
import { normalizeClaudeRemoteMode } from './normalizeClaudeRemoteMode';

function resolveClaudeRemoteSettingSourcesOverrideForAgentSdk(mode: EnhancedMode): readonly ('user' | 'project' | 'local')[] | null {
    const rawV2 = (mode as any).claudeRemoteSettingSourcesV2 as unknown;
    if (Array.isArray(rawV2)) {
        const set = new Set<string>();
        for (const value of rawV2) {
            if (typeof value === 'string') set.add(value);
        }
        const normalized: Array<'user' | 'project' | 'local'> = [];
        for (const key of ['user', 'project', 'local'] as const) {
            if (set.has(key)) normalized.push(key);
        }
        // All sources selected => don't force an override.
        if (normalized.length === 3) return null;
        return normalized;
    }

    // Legacy v1 mapping (back-compat).
    const legacy = mode.claudeRemoteSettingSources;
    if (legacy === 'none') return [];
    if (legacy === 'user_project') return ['user', 'project'];
    if (legacy === 'project') return ['project'];
    return null;
}

const DEBUG_CATEGORIES_ORDER = ['api', 'mcp', 'hooks', 'file', '1p'] as const;

function normalizeClaudeRemoteDebugCategories(mode: EnhancedMode): readonly string[] {
    const raw = mode.claudeRemoteDebugCategories;
    if (!Array.isArray(raw)) return [];
    const set = new Set<string>();
    for (const value of raw) {
        set.add(value);
    }
    const out: string[] = [];
    for (const key of DEBUG_CATEGORIES_ORDER) {
        if (set.has(key)) out.push(key);
    }
    return out;
}

function resolveEffectiveClaudeAgentModeId(mode: EnhancedMode): string {
    const raw = typeof mode.agentModeId === 'string' ? mode.agentModeId.trim() : '';
    if (raw) return raw;
    // Back-compat: historically "plan" was encoded as a permissionMode.
    if (mode.permissionMode === 'plan') return 'plan';
    return '';
}

function buildClaudeUnifiedTerminalLaunchOptionsHashInput(mode: EnhancedMode): Readonly<Record<string, unknown>> {
    const effectiveAgentModeId = resolveEffectiveClaudeAgentModeId(mode);
    const claudeSdkPermissionMode = resolveClaudeSdkPermissionModeFromEnhancedMode({
        permissionMode: mode.permissionMode,
        agentModeId: effectiveAgentModeId,
    });
    const supportedLevels = resolveModeEffortLevelsForModel(mode, mode.model);
    const resolvedEffort = resolveClaudeEffortForModel({
        modelId: mode.model,
        effort: mode.reasoningEffort,
        supportedLevels,
    });
    const resolvedUltracode = resolveClaudeUltracodeForModel({
        modelId: mode.model,
        ultracode: mode.ultracode,
        supportedLevels,
    });
    const debugCategories = normalizeClaudeRemoteDebugCategories(mode);

    return {
        claudeUnifiedTerminalHost: mode.claudeUnifiedTerminalHost ?? 'auto',
        claudeUnifiedTerminalResumeChoice: mode.claudeUnifiedTerminalResumeChoice ?? 'ask_every_time',
        ultracode: resolvedUltracode,
        claudeSdkPermissionMode,
        agentModeId: effectiveAgentModeId || null,
        model: mode.model,
        effort: resolvedEffort,
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        claudeRemoteSettingSourcesOverride: resolveClaudeRemoteSettingSourcesOverrideForAgentSdk(mode),
        claudeRemoteDisableTodos: mode.claudeRemoteDisableTodos,
        claudeRemoteStrictMcpServerConfig: mode.claudeRemoteStrictMcpServerConfig,
        claudeRemoteMaxThinkingTokens: mode.claudeRemoteMaxThinkingTokens,
        claudeRemoteDebugEnabled: mode.claudeRemoteDebugEnabled === true,
        claudeRemoteVerboseEnabled: mode.claudeRemoteVerboseEnabled === true,
        claudeRemoteDebugCategories: debugCategories,
        claudeRemoteAdvancedOptionsJson: mode.claudeRemoteAdvancedOptionsJson,
    };
}

export function hashClaudeUnifiedTerminalLaunchOptionsForQueue(mode: EnhancedMode): string {
    return hashObject(buildClaudeUnifiedTerminalLaunchOptionsHashInput(mode));
}

export function hashClaudeEnhancedModeForQueue(mode: EnhancedMode): string {
    const remoteMode = normalizeClaudeRemoteMode(mode);
    const effectiveAgentModeId = resolveEffectiveClaudeAgentModeId(mode);
    const claudeSdkPermissionMode = resolveClaudeSdkPermissionModeFromEnhancedMode({
        permissionMode: mode.permissionMode,
        agentModeId: effectiveAgentModeId,
    });

    // Spawn-only config for Claude: effort is a query-start option in the Agent SDK and has no dynamic setter.
    // We normalize effort to the effective value the provider would actually apply (treating "high" as default).
    const supportedLevels = resolveModeEffortLevelsForModel(mode, mode.model);
    const resolvedEffort = resolveClaudeEffortForModel({
        modelId: mode.model,
        effort: mode.reasoningEffort,
        supportedLevels,
    });
    const resolvedUltracode = resolveClaudeUltracodeForModel({
        modelId: mode.model,
        ultracode: mode.ultracode,
        supportedLevels,
    });

    const debugCategories = normalizeClaudeRemoteDebugCategories(mode);

    if (remoteMode.kind === 'unifiedTerminal') {
        return hashObject({
            unifiedTerminal: true,
            replaySeedAllowed: mode.replaySeedAllowed !== false,
            ...buildClaudeUnifiedTerminalLaunchOptionsHashInput(mode),
        });
    }

    if (remoteMode.kind === 'legacy') {
        return hashObject({
            claudeSdkPermissionMode,
            agentModeId: effectiveAgentModeId || null,
            replaySeedAllowed: mode.replaySeedAllowed !== false,
            model: mode.model,
            effort: resolvedEffort,
            fallbackModel: mode.fallbackModel,
            customSystemPrompt: mode.customSystemPrompt,
            appendSystemPrompt: mode.appendSystemPrompt,
            claudeRemoteDisableTodos: mode.claudeRemoteDisableTodos,
            claudeRemoteDebugEnabled: mode.claudeRemoteDebugEnabled === true,
            claudeRemoteVerboseEnabled: mode.claudeRemoteVerboseEnabled === true,
            claudeRemoteDebugCategories: debugCategories,
        });
    }

    const settingSourcesOverride = resolveClaudeRemoteSettingSourcesOverrideForAgentSdk(mode);

    return hashObject({
        agentSdk: true,
        claudeSdkPermissionMode,
        agentModeId: effectiveAgentModeId || null,
        replaySeedAllowed: mode.replaySeedAllowed !== false,
        claudeRemoteSettingSourcesOverride: settingSourcesOverride,
        claudeRemoteEnableFileCheckpointing: mode.claudeRemoteEnableFileCheckpointing,
        claudeRemoteDisableTodos: mode.claudeRemoteDisableTodos,
        claudeRemoteStrictMcpServerConfig: mode.claudeRemoteStrictMcpServerConfig,
        claudeRemoteDebugEnabled: mode.claudeRemoteDebugEnabled === true,
        claudeRemoteVerboseEnabled: mode.claudeRemoteVerboseEnabled === true,
        claudeRemoteDebugCategories: debugCategories,
        claudeRemoteAdvancedOptionsJson: mode.claudeRemoteAdvancedOptionsJson,
        effort: resolvedEffort,
        ultracode: resolvedUltracode,
        // Restart-required (SDK has no dynamic setter)
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
    });
}
