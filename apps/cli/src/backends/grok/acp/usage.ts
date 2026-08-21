import type { AcpPromptUsageAdapter } from '@/agent/acp/AcpBackend';

const USD_TICKS_PER_DOLLAR = 10_000_000_000;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export const grokPromptUsageAdapter: AcpPromptUsageAdapter = Object.freeze({
  project({ usage }) {
    const record = asRecord(usage);
    if (!record) return null;

    const input = asNonNegativeNumber(record.inputTokens);
    const output = asNonNegativeNumber(record.outputTokens);
    const cacheRead = asNonNegativeNumber(record.cachedReadTokens);
    const cacheCreation = asNonNegativeNumber(record.cacheCreationTokens);
    const reasoning = asNonNegativeNumber(record.reasoningTokens);
    const explicitTotal = asNonNegativeNumber(record.totalTokens);
    if (
      explicitTotal === null
      && input === null
      && output === null
      && cacheRead === null
      && cacheCreation === null
      && reasoning === null
    ) return null;

    // Grok reports cache reads as part of input and reasoning as part of output.
    // They remain useful detail buckets, but are not additive token classes.
    const tokens: Record<string, number> = {
      total: explicitTotal ?? (input ?? 0) + (output ?? 0),
    };
    if (input !== null) tokens.input = input;
    if (output !== null) tokens.output = output;
    if (cacheRead !== null) tokens.cache_read = cacheRead;
    if (cacheCreation !== null) tokens.cache_creation = cacheCreation;
    if (reasoning !== null) tokens.thought = reasoning;

    const costTicks = asNonNegativeNumber(record.costUsdTicks);
    const costIsTrustworthy = costTicks !== null
      && record.costIsPartial !== true
      && record.usageIsIncomplete !== true;

    return {
      tokens,
      ...(costIsTrustworthy ? { cost: { total: costTicks / USD_TICKS_PER_DOLLAR } } : {}),
    };
  },
});
