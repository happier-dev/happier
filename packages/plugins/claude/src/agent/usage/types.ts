import type { SessionContextUsageSnapshotV1 } from '@happier-dev/plugin-sdk/usage';

export type ClaudeTokenUsage = Readonly<{
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}>;

export type ClaudeUsageObservation = {
    provider: 'claude';
    source: 'claude-assistant-usage' | 'claude-sdk-result';
    scope: 'turn_delta' | 'session_final';
    key: 'claude-session';
    modelId: string | null;
    tokens: {
        total: number;
        [key: string]: number;
    };
    cost: {
        total: number;
        reportedUsd?: number;
        estimatedUsd?: number;
        input?: number;
        output?: number;
        billingContext?: 'unknown';
        costSource?: 'provider_reported' | 'pricing_estimate';
        [key: string]: number | string | undefined;
    } | null;
    contextUsedTokens: number | null;
    contextWindowTokens: number | null;
    contextSnapshot?: SessionContextUsageSnapshotV1;
};
