import type {
    SessionContextUsageSnapshotV1,
    UsageObservationCost,
    UsageObservationTokens,
} from '@happier-dev/plugin-sdk/experimental/usage';

export type ClaudeTokenUsage = Readonly<{
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}>;

export type ClaudeUsageModelSource = 'claude-native' | 'provider';

export type ClaudeUsageObservation = {
    provider: 'claude';
    source: 'claude-assistant-usage' | 'claude-sdk-result';
    scope: 'turn_delta' | 'session_final';
    key: 'claude-session';
    modelId: string | null;
    tokens: UsageObservationTokens;
    cost: UsageObservationCost | null;
    contextUsedTokens: number | null;
    contextWindowTokens: number | null;
    contextSnapshot?: SessionContextUsageSnapshotV1;
};

export type ClaudeUsageObservationSubscription = (
    listener: (observation: ClaudeUsageObservation) => void,
) => () => void;
