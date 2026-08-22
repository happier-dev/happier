import type { AgentAcpPromptUsageDefinition } from '@happier-dev/plugin-sdk/agents/runtime';

const USD_TICKS_PER_DOLLAR = 10_000_000_000;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export const GROK_PROMPT_USAGE: AgentAcpPromptUsageDefinition = Object.freeze({
  projectPromptUsage({ usage }) {
    const record = asRecord(usage);
    if (!record) return null;

    const input = asNonNegativeNumber(record.inputTokens);
    const output = asNonNegativeNumber(record.outputTokens);
    const cacheRead = asNonNegativeNumber(record.cachedReadTokens);
    const cacheWrite = asNonNegativeNumber(record.cacheCreationTokens);
    const reasoning = asNonNegativeNumber(record.reasoningTokens);
    const explicitTotal = asNonNegativeNumber(record.totalTokens);
    if (
      explicitTotal === null
      && input === null
      && output === null
      && cacheRead === null
      && cacheWrite === null
      && reasoning === null
    ) return null;

    const tokens: Record<string, number> = {
      total: explicitTotal ?? (input ?? 0) + (output ?? 0),
    };
    if (input !== null) tokens.input = input;
    if (output !== null) tokens.output = output;
    if (cacheRead !== null) tokens.cacheRead = cacheRead;
    if (cacheWrite !== null) tokens.cacheWrite = cacheWrite;
    if (reasoning !== null) tokens.reasoning = reasoning;

    const costTicks = asNonNegativeNumber(record.costUsdTicks);
    const costIsTrustworthy = costTicks !== null
      && record.costIsPartial !== true
      && record.usageIsIncomplete !== true;
    const cost = costIsTrustworthy ? costTicks / USD_TICKS_PER_DOLLAR : null;

    return {
      tokens,
      ...(cost !== null
        ? {
            cost: {
              total: cost,
              reportedUsd: cost,
              costSource: 'provider_reported',
            },
          }
        : {}),
    };
  },
});
