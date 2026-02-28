import { hashObject } from '@/utils/deterministicJson';

import type { EnhancedMode } from '@/backends/claude/loop';
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from '@/backends/claude/utils/permissionMode';

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
            model: mode.model,
            fallbackModel: mode.fallbackModel,
            customSystemPrompt: mode.customSystemPrompt,
            appendSystemPrompt: mode.appendSystemPrompt,
            claudeRemoteDisableTodos: mode.claudeRemoteDisableTodos,
        });
    }

    return hashObject({
        agentSdk: true,
        claudeSdkPermissionMode,
        agentModeId: effectiveAgentModeId || null,
        claudeRemoteSettingSources: mode.claudeRemoteSettingSources,
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
