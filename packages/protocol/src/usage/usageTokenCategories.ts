import type { UsageAccountingMetadata, UsageAnalyticsTokens, UsageObservationTokens } from './usageAnalyticsContracts.js';

export type MeasuredUsageTokenCategories = UsageObservationTokens & Record<Exclude<keyof UsageObservationTokens, 'total'>, number>;

/** A tariff needs each disjoint component; the vendor total is independent. */
export function hasMeasuredUsageTokenCategories<T extends UsageObservationTokens>(
  tokens: T | null | undefined,
): tokens is T & MeasuredUsageTokenCategories {
  return tokens != null && tokens.input !== null && tokens.output !== null && tokens.reasoning !== null
    && tokens.cacheRead !== null && tokens.cacheWrite !== null;
}

/** Zero measured parts establish no usage only without a positive reported total. */
export function hasZeroUsageTokens(tokens: UsageObservationTokens | null | undefined): boolean {
  return tokens != null && (tokens.total === null || tokens.total === 0)
    && tokens.input === 0 && tokens.output === 0 && tokens.reasoning === 0
    && tokens.cacheRead === 0 && tokens.cacheWrite === 0;
}

/** Disjoint chart categories require producer-witnessed vendor counter semantics. */
export function resolveUsageTokenCategories(tokens: UsageAnalyticsTokens, accounting: UsageAccountingMetadata | null | undefined): MeasuredUsageTokenCategories | null {
  if (!hasMeasuredUsageTokenCategories(tokens)) return null;
  const { input, output, reasoning, cacheRead, cacheWrite } = tokens;
  if ((cacheRead > 0 || cacheWrite > 0) && accounting?.inputIncludesCache === undefined) return null;
  if (reasoning > 0 && accounting?.outputIncludesReasoning === undefined) return null;
  if (accounting?.inputIncludesCache === true && cacheRead + cacheWrite > input
    || accounting?.outputIncludesReasoning === true && reasoning > output) return null;
  const { measured: _measured, ...raw } = tokens;
  return {
    ...raw,
    input: accounting?.inputIncludesCache === true ? Math.max(0, input - cacheRead - cacheWrite) : input,
    output: accounting?.outputIncludesReasoning === true ? Math.max(0, output - reasoning) : output,
  };
}
