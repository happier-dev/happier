/** Pre-v2 ACP `token_count` compatibility; see `legacyUsageTransport.ts` for removal conditions. */
import { extractUsageObservationFromTokenCountMessage } from '../usageObservation';

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
