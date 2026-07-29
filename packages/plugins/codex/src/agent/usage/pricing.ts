export type CodexUsageNumberMap = Readonly<{
    total: number;
    [key: string]: number;
}>;

export type CodexUsageCost = Readonly<{
    total: number;
    estimatedUsd: number;
    input: number;
    output: number;
    breakdown?: Readonly<Record<string, number>>;
}>;

type CodexModelPricing = Readonly<{
    input: number;
    cachedInput: number;
    output: number;
}>;

const MILLION = 1_000_000;

const CODEX_MODEL_PRICING: Record<string, CodexModelPricing> = {
    'gpt-5.4': {
        input: 2.5,
        cachedInput: 0.25,
        output: 15,
    },
    'gpt-5.4-mini': {
        input: 0.75,
        cachedInput: 0.075,
        output: 4.5,
    },
    'gpt-5.2-codex': {
        input: 1.75,
        cachedInput: 0.175,
        output: 14,
    },
    'gpt-5.2': {
        input: 1.75,
        cachedInput: 0.175,
        output: 14,
    },
    'gpt-5.3-codex': {
        input: 1.75,
        cachedInput: 0.175,
        output: 14,
    },
    'gpt-5.1-codex-max': {
        input: 1.25,
        cachedInput: 0.125,
        output: 10,
    },
    'gpt-5.1-codex': {
        input: 1.25,
        cachedInput: 0.125,
        output: 10,
    },
    'gpt-5.1-codex-mini': {
        input: 0.25,
        cachedInput: 0.025,
        output: 2,
    },
};

function normalizeModelId(modelId: string | null | undefined): string | null {
    if (typeof modelId !== 'string') return null;
    const trimmed = modelId.trim().toLowerCase();
    if (!trimmed) return null;
    return trimmed.replace(/^openai\//, '');
}

function resolvePricing(modelId: string | null | undefined): CodexModelPricing | null {
    const normalized = normalizeModelId(modelId);
    if (!normalized) return null;
    const direct = CODEX_MODEL_PRICING[normalized];
    if (direct) return direct;

    if (normalized === 'gpt-5-codex') {
        return CODEX_MODEL_PRICING['gpt-5.1-codex-max'];
    }

    return null;
}

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function estimateCodexUsageCost(params: Readonly<{
    modelId: string | null | undefined;
    tokens: CodexUsageNumberMap | null;
}>): CodexUsageCost | null {
    const pricing = resolvePricing(params.modelId);
    const tokens = params.tokens;
    if (!pricing || !tokens) return null;

    const inputTokens = asFiniteNonNegativeNumber(tokens.input) ?? 0;
    const reportedCachedInputTokens = asFiniteNonNegativeNumber(tokens.cache_read) ?? 0;
    const cachedInputTokens = Math.min(inputTokens, reportedCachedInputTokens);
    const outputTokens = asFiniteNonNegativeNumber(tokens.output) ?? 0;
    const nonCachedInputTokens = inputTokens - cachedInputTokens;

    const inputCost = (nonCachedInputTokens / MILLION) * pricing.input;
    const cachedInputCost = (cachedInputTokens / MILLION) * pricing.cachedInput;
    const cacheSavingsUsd = (cachedInputTokens / MILLION) * (pricing.input - pricing.cachedInput);
    const outputCost = (outputTokens / MILLION) * pricing.output;
    const total = inputCost + cachedInputCost + outputCost;

    if (!Number.isFinite(total) || total <= 0) return null;

    return {
        total,
        estimatedUsd: total,
        input: inputCost + cachedInputCost,
        output: outputCost,
        ...(cacheSavingsUsd > 0 ? { breakdown: { cacheSavingsUsd } } : {}),
    };
}
