import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

type UsageTokens = NonNullable<Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>['tokens']>;

function measured(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function readMuseUsageTokens(usage: Readonly<Record<string, unknown>>, input: unknown, total: unknown): UsageTokens | undefined {
  const tokens = {
    input: measured(input), output: measured(usage.outputTokens), reasoning: measured(usage.reasoningTokens),
    cacheRead: measured(usage.cacheReadTokens), cacheWrite: measured(usage.cacheWriteTokens), total: measured(total),
  };
  return Object.values(tokens).some(value => value !== null) ? tokens : undefined;
}
