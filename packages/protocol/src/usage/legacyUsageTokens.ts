import type { UsageObservationTokens } from './usageAnalyticsContracts.js';

const INPUT_KEYS = ['input', 'prompt', 'input_tokens'] as const;
const OUTPUT_KEYS = ['output', 'completion', 'output_tokens'] as const;
const REASONING_KEYS = ['reasoning', 'reasoning_tokens'] as const;
const CACHE_READ_KEYS = ['cache_read', 'cacheRead', 'cache_read_input_tokens'] as const;
const CACHE_WRITE_KEYS = ['cache_creation', 'cache_write', 'cacheWrite', 'cache_creation_input_tokens'] as const;

function firstNumber(source: Record<string, number>, keys: readonly string[]): number {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
}

export function normalizeLegacyUsageTokens(source: Record<string, number>): UsageObservationTokens {
    return {
        input: firstNumber(source, INPUT_KEYS),
        output: firstNumber(source, OUTPUT_KEYS),
        reasoning: firstNumber(source, REASONING_KEYS),
        cacheRead: firstNumber(source, CACHE_READ_KEYS),
        cacheWrite: firstNumber(source, CACHE_WRITE_KEYS),
        total: firstNumber(source, ['total']),
    };
}
