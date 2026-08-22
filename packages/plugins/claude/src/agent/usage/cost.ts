import type { ClaudeTokenUsage } from './types.js';
import { stripClaude1mSuffix } from '../contextWindow.js';

type ClaudeModelPricing = Readonly<{
    input: number;
    output: number;
    cache_write: number;
    cache_read: number;
}>;

const PRICING: Record<string, ClaudeModelPricing> = {
    // Exact Claude API ids/aliases at standard global pricing, verified 2026-07-30:
    // https://platform.claude.com/docs/en/about-claude/pricing
    'claude-fable-5': {
        input: 10.0,
        output: 50.0,
        cache_write: 12.50,
        cache_read: 1.0,
    },
    'claude-mythos-5': {
        input: 10.0,
        output: 50.0,
        cache_write: 12.50,
        cache_read: 1.0,
    },
    'claude-opus-4-8': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50,
    },
    'claude-opus-4-7': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50,
    },
    'claude-opus-4-6': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50,
    },
    'claude-opus-4-5': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50,
    },
    'claude-opus-4-5-20251101': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50,
    },
    'claude-opus-4-1': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.50,
    },
    'claude-opus-4-1-20250805': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.50,
    },
    'claude-sonnet-4-6': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30,
    },
    'claude-sonnet-4-5': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30,
    },
    'claude-sonnet-4-5-20250929': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30,
    },
    'claude-haiku-4-5': {
        input: 1.0,
        output: 5.0,
        cache_write: 1.25,
        cache_read: 0.10,
    },
    'claude-haiku-4-5-20251001': {
        input: 1.0,
        output: 5.0,
        cache_write: 1.25,
        cache_read: 0.10,
    },
    'claude-3-opus-20240229': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.5,
    },
    'claude-3-sonnet-20240229': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3,
    },
    'claude-3-5-sonnet-20240620': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3,
    },
    'claude-3-5-sonnet-20241022': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3,
    },
    'claude-3-haiku-20240307': {
        input: 0.25,
        output: 1.25,
        cache_write: 0.3125,
        cache_read: 0.025,
    },
    'claude-3-5-haiku-20241022': {
        input: 0.8,
        output: 4.0,
        cache_write: 1.0,
        cache_read: 0.08,
    },
};

// Anthropic publishes a calendar effective date without a timezone; epoch observations
// use the UTC day boundary so historical estimates remain deterministic.
const SONNET_5_STANDARD_PRICING_START_MS = Date.UTC(2026, 8, 1);
const SONNET_5_INTRODUCTORY_PRICING: ClaudeModelPricing = {
    input: 2.0,
    output: 10.0,
    cache_write: 2.50,
    cache_read: 0.20,
};
const SONNET_5_STANDARD_PRICING: ClaudeModelPricing = {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.30,
};

function normalizeModelId(modelId: string | null | undefined): string {
    return typeof modelId === 'string'
        ? stripClaude1mSuffix(modelId).toLowerCase()
        : '';
}

function resolvePricing(modelId?: string, observedAtMs?: number): ClaudeModelPricing | null {
    const normalized = normalizeModelId(modelId);
    if (normalized === 'claude-sonnet-5') {
        if (typeof observedAtMs !== 'number' || !Number.isFinite(observedAtMs)) return null;
        return observedAtMs < SONNET_5_STANDARD_PRICING_START_MS
            ? SONNET_5_INTRODUCTORY_PRICING
            : SONNET_5_STANDARD_PRICING;
    }
    return PRICING[normalized] ?? null;
}

export function estimateClaudeUsageCost(
    usage: ClaudeTokenUsage,
    modelId?: string,
    observedAtMs?: number,
): { total: number; input: number; output: number; breakdown?: Readonly<Record<string, number>> } | null {
    const pricing = resolvePricing(modelId, observedAtMs);
    if (!pricing) return null;
    const inputTokens = Math.max(0, usage.input_tokens ?? 0);
    const outputTokens = Math.max(0, usage.output_tokens ?? 0);
    const cacheWriteTokens = Math.max(0, usage.cache_creation_input_tokens ?? 0);
    const cacheReadTokens = Math.max(0, usage.cache_read_input_tokens ?? 0);

    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cache_write;
    const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cache_read;
    const cacheSavingsUsd = (cacheReadTokens / 1_000_000) * (pricing.input - pricing.cache_read);
    const totalInputCost = inputCost + cacheWriteCost + cacheReadCost;

    return {
        total: totalInputCost + outputCost,
        input: totalInputCost,
        output: outputCost,
        ...(cacheSavingsUsd > 0 ? { breakdown: { cacheSavingsUsd } } : {}),
    };
}
