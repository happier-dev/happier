import { hashObject } from '@/utils/deterministicJson';

import type { EnhancedMode } from '@/backends/claude/loop';

export function hashClaudeEnhancedModeForQueue(mode: EnhancedMode): string {
    const agentSdkEnabled = mode.claudeRemoteAgentSdkEnabled === true;

    if (!agentSdkEnabled) {
        return hashObject({
            isPlan: mode.permissionMode === 'plan',
            model: mode.model,
            fallbackModel: mode.fallbackModel,
            customSystemPrompt: mode.customSystemPrompt,
            appendSystemPrompt: mode.appendSystemPrompt,
            allowedTools: mode.allowedTools,
            disallowedTools: mode.disallowedTools,
            claudeRemoteDisableTodos: mode.claudeRemoteDisableTodos,
        });
    }

    return hashObject({
        agentSdk: true,
        claudeRemoteSettingSources: mode.claudeRemoteSettingSources,
        claudeRemoteEnableFileCheckpointing: mode.claudeRemoteEnableFileCheckpointing,
        claudeRemoteDisableTodos: mode.claudeRemoteDisableTodos,
        claudeRemoteStrictMcpServerConfig: mode.claudeRemoteStrictMcpServerConfig,
        claudeRemoteAdvancedOptionsJson: mode.claudeRemoteAdvancedOptionsJson,
        // Restart-required (SDK has no dynamic setter)
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools,
    });
}
