import { sumKnownUsageTokenParts } from '@happier-dev/protocol/usage/usageAggregation';

/**
 * The one token-total rule for a period, bucket or agent: the reported aggregate total, or else, when no agent
 * reported one, the sum of the parts they did report (input, output, reasoning, cache) as a measured floor. Only
 * a population with no measured part is unknown. Consumers never compare a floor with an earlier period's total.
 */
export function resolveUsageMeasuredTokens(tokens: Readonly<{ input: number | null; output: number | null;
    reasoning: number | null; cacheRead: number | null; cacheWrite: number | null; total: number | null }>,
): Readonly<{ total: number | null; fromParts: boolean }> {
    if (tokens.total !== null) return { total: tokens.total, fromParts: false };
    const parts = sumKnownUsageTokenParts(tokens);
    return { total: parts, fromParts: parts !== null };
}
