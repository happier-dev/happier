export type ClaudeSessionHandoffProviderPatch = Readonly<{
    clearMetadataKeys?: readonly string[];
}>;

export function buildClaudeSessionHandoffProviderPatch(): ClaudeSessionHandoffProviderPatch {
    return {
        clearMetadataKeys: [
            'claudeTranscriptPath',
            'claudeLastCheckpointId',
            'claudeLastAssistantUuid',
        ],
    };
}
