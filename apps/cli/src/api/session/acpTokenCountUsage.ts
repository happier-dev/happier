import { extractUsageObservationFromTokenCountMessage } from '@/usage/usageObservation';

type TokenCountExtraction = {
    key: string | null;
    modelId: string | null;
    tokens: Record<string, number>;
};

export function extractTokensFromAcpTokenCountMessage(body: unknown): TokenCountExtraction | null {
    const observation = extractUsageObservationFromTokenCountMessage({
        provider: 'unknown',
        body,
    });
    if (!observation?.tokens) return null;
    return {
        key: observation.key,
        modelId: observation.modelId,
        tokens: observation.tokens,
    };
}
