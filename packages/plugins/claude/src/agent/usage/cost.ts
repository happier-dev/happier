import type { ClaudeTokenUsage } from './types.js';

type ClaudeModelPricing = Readonly<{
    input: number;
    output: number;
    cache_write: number;
    cache_read: number;
}>;

const PRICING: Record<string, ClaudeModelPricing> = {
    'claude-4.5-opus': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50,
    },
    'claude-4.1-opus': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.50,
    },
    'claude-4-opus': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.50,
    },
    'claude-4.5-sonnet': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30,
    },
    'claude-4-sonnet': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30,
    },
    'claude-4.5-haiku': {
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

function normalizeModelId(modelId: string | null | undefined): string {
    return typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
}

function resolvePricing(modelId?: string): ClaudeModelPricing | null {
    const normalized = normalizeModelId(modelId);
    const direct = PRICING[normalized];
    if (direct) return direct;

    if (normalized.includes('opus')) {
        if (normalized.includes('4.5')) return PRICING['claude-4.5-opus'];
        if (normalized.includes('4.1')) return PRICING['claude-4.1-opus'];
        if (normalized.includes('4')) return PRICING['claude-4-opus'];
        return PRICING['claude-3-opus-20240229'];
    }

    if (normalized.includes('sonnet')) {
        if (normalized.includes('4.5')) return PRICING['claude-4.5-sonnet'];
        if (normalized.includes('4')) return PRICING['claude-4-sonnet'];
        return PRICING['claude-3-5-sonnet-20241022'];
    }

    if (normalized.includes('haiku')) {
        if (normalized.includes('4.5')) return PRICING['claude-4.5-haiku'];
        if (normalized.includes('3.5')) return PRICING['claude-3-5-haiku-20241022'];
        return PRICING['claude-3-haiku-20240307'];
    }

    return null;
}

export function estimateClaudeUsageCost(
    usage: ClaudeTokenUsage,
    modelId?: string,
): { total: number; input: number; output: number; breakdown?: Readonly<Record<string, number>> } | null {
    const pricing = resolvePricing(modelId);
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
