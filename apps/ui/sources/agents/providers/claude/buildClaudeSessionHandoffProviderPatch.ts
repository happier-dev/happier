import type { AgentSessionHandoffProviderPatch } from '@/agents/registry/registryUiBehavior';

export function buildClaudeSessionHandoffProviderPatch(): AgentSessionHandoffProviderPatch {
    return {
        clearMetadataKeys: [
            'claudeTranscriptPath',
            'claudeLastCheckpointId',
            'claudeLastAssistantUuid',
        ],
    };
}
