import type { AgentAcpPromptUsageDefinition } from '@happier-dev/plugin-sdk/agents/runtime';

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export const FX_PROMPT_USAGE = Object.freeze({
  projectPromptUsage({ usage }) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
    // Array.isArray does not narrow the readonly JSON-array arm of this union.
    const record = usage as Exclude<typeof usage, readonly unknown[]>;
    const input = nonNegativeNumber(record.inputTokens);
    const output = nonNegativeNumber(record.outputTokens);
    if (nonNegativeNumber(record.totalTokens) !== null || input === null || output === null) return record;

    // fx 0.0.14 carries cache details within input and reasoning within output
    // (src/gateway/responses_protocol.zig). Canonical token normalization stays host-owned.
    return { ...record, totalTokens: input + output };
  },
} satisfies AgentAcpPromptUsageDefinition);
