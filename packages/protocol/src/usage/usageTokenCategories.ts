import type { UsageAccountingMetadata, UsageObservationTokens } from './usageAnalyticsContracts.js';

/** Disjoint chart categories require producer-witnessed vendor counter semantics. */
export function resolveUsageTokenCategories(tokens: UsageObservationTokens, accounting: UsageAccountingMetadata | null | undefined): UsageObservationTokens | null {
  if ((tokens.cacheRead > 0 || tokens.cacheWrite > 0) && accounting?.inputIncludesCache === undefined) return null;
  if (tokens.reasoning > 0 && accounting?.outputIncludesReasoning === undefined) return null;
  if (accounting?.inputIncludesCache === true && tokens.cacheRead + tokens.cacheWrite > tokens.input
    || accounting?.outputIncludesReasoning === true && tokens.reasoning > tokens.output) return null;
  return {
    ...tokens,
    input: accounting?.inputIncludesCache === true ? Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite) : tokens.input,
    output: accounting?.outputIncludesReasoning === true ? Math.max(0, tokens.output - tokens.reasoning) : tokens.output,
  };
}
