import { hashObject } from '@/utils/deterministicJson';

import type { EnhancedMode } from '@/backends/claude/loop';
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from '@/backends/claude/utils/permissionMode';

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

export function hashClaudeEnhancedModeForQueue(mode: EnhancedMode): string {
    const agentSdkEnabled = mode.claudeRemoteAgentSdkEnabled === true;
    const effectiveAgentModeId = (() => {
        const raw = typeof mode.agentModeId === 'string' ? mode.agentModeId.trim() : '';
        if (raw) return raw;
        // Back-compat: historically "plan" was encoded as a permissionMode.
        if (mode.permissionMode === 'plan') return 'plan';
        return '';
    })();
    const claudeSdkPermissionMode = resolveClaudeSdkPermissionModeFromEnhancedMode({
        permissionMode: mode.permissionMode,
        agentModeId: effectiveAgentModeId,
    });

    if (!agentSdkEnabled) {
        return hashObject({
            claudeSdkPermissionMode,
            agentModeId: effectiveAgentModeId || null,
            replaySeedAllowed: mode.replaySeedAllowed !== false,
            model: mode.model,
            fallbackModel: mode.fallbackModel,
            customSystemPrompt: mode.customSystemPrompt,
            appendSystemPrompt: mode.appendSystemPrompt,
            claudeRemoteDisableTodos: mode.claudeRemoteDisableTodos,
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
        claudeRemoteAdvancedOptionsJson: mode.claudeRemoteAdvancedOptionsJson,
        // Restart-required (SDK has no dynamic setter)
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
    });
}
