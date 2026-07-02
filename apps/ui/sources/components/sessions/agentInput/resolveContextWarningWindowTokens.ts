import type { AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { getAgentStaticModels } from '@happier-dev/agents';

export const DEFAULT_CONTEXT_WARNING_WINDOW_TOKENS = 190_000;
export const CLAUDE_1M_CONTEXT_WARNING_WINDOW_TOKENS = 950_000;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const CLAUDE_1M_CONTEXT_WINDOW_TOKENS = 1_000_000;
const CONTEXT_WARNING_WINDOW_RATIO = 0.95;
// Claude context-window sizes Happier knows about, ascending (the observed-usage
// evidence bump ladder).
const CLAUDE_KNOWN_CONTEXT_WINDOW_TOKENS: readonly number[] = [
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
];

function normalizeModelId(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function normalizeContextWindowTokens(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
}

function isClaude1mModelId(modelId: string): boolean {
    return modelId.endsWith('[1m]');
}

function descriptionSuggestsClaude1m(description: unknown): boolean {
    if (typeof description !== 'string') return false;
    const normalized = description.trim().toLowerCase();
    return normalized.includes('1 million') || normalized.includes('1m context');
}

function resolveCatalogContextWindowTokens(agentId: AgentId, modelId: string): number | null {
    if (!modelId) return null;
    const matchingModel = getAgentStaticModels(agentId)
        .find((model) => normalizeModelId(model.id) === modelId) ?? null;
    return normalizeContextWindowTokens(matchingModel?.contextWindowTokens);
}

export function toContextWarningWindowTokens(contextWindowTokens: number): number {
    return Math.max(1, Math.floor(contextWindowTokens * CONTEXT_WARNING_WINDOW_RATIO));
}

type ContextUsageData = Readonly<{
    contextWindowTokens?: number;
    contextSize?: number;
}> | null | undefined;

/**
 * Evidence fallback: when observed context usage exceeds the assumed window, the
 * assumption is stale (e.g. the user enabled 1M provider-side or the session runs an
 * always-1M model with no published model metadata). Bump to the smallest known Claude
 * window that fits the observation; beyond every known window, trust the observation
 * itself so percent math never exceeds 100%.
 */
function bumpClaudeContextWindowTokensForObservedUsage(
    contextWindowTokens: number,
    observedUsedTokens: unknown,
): number {
    const observed = typeof observedUsedTokens === 'number' && Number.isFinite(observedUsedTokens) && observedUsedTokens > 0
        ? Math.trunc(observedUsedTokens)
        : 0;
    if (observed <= contextWindowTokens) return contextWindowTokens;
    for (const known of CLAUDE_KNOWN_CONTEXT_WINDOW_TOKENS) {
        if (known >= observed) return known;
    }
    return observed;
}

export function resolveContextWindowTokens(params: Readonly<{
    agentId: AgentId;
    metadata: Metadata | null | undefined;
    usageData?: ContextUsageData;
}>): number | null {
    const assumed = resolveAssumedContextWindowTokens(params);
    if (assumed === null || params.agentId !== 'claude') {
        return assumed;
    }
    return bumpClaudeContextWindowTokensForObservedUsage(assumed, params.usageData?.contextSize);
}

function resolveAssumedContextWindowTokens(params: Readonly<{
    agentId: AgentId;
    metadata: Metadata | null | undefined;
    usageData?: ContextUsageData;
}>): number | null {
    const liveContextWindowTokens = normalizeContextWindowTokens(params.usageData?.contextWindowTokens);
    if (liveContextWindowTokens !== null) {
        return liveContextWindowTokens;
    }

    const overrideModelId = normalizeModelId(params.metadata?.modelOverrideV1?.modelId);
    const sessionModelsState = readSessionModelsState(params.metadata);
    if (sessionModelsState && sessionModelsState.provider === params.agentId) {
        const activeModelId = overrideModelId || normalizeModelId(sessionModelsState.currentModelId);
        const matchingModel = Array.isArray(sessionModelsState.availableModels)
            ? sessionModelsState.availableModels.find((model) => normalizeModelId(model.id) === activeModelId)
            : null;
        const contextWindowTokens = normalizeContextWindowTokens(matchingModel?.contextWindowTokens)
            ?? resolveCatalogContextWindowTokens(params.agentId, activeModelId);
        if (contextWindowTokens !== null) {
            return contextWindowTokens;
        }
    }

    const overrideCatalogContextWindowTokens = resolveCatalogContextWindowTokens(params.agentId, overrideModelId);
    if (overrideCatalogContextWindowTokens !== null) {
        return overrideCatalogContextWindowTokens;
    }

    if (params.agentId !== 'claude') {
        return null;
    }

    if (isClaude1mModelId(overrideModelId)) return CLAUDE_1M_CONTEXT_WINDOW_TOKENS;

    if (!sessionModelsState || sessionModelsState.provider !== 'claude') {
        return DEFAULT_CONTEXT_WINDOW_TOKENS;
    }

    const currentModelId = normalizeModelId(sessionModelsState.currentModelId);
    if (isClaude1mModelId(currentModelId)) return CLAUDE_1M_CONTEXT_WINDOW_TOKENS;

    const matchingModel = Array.isArray(sessionModelsState.availableModels)
        ? sessionModelsState.availableModels.find((model) => normalizeModelId(model.id) === currentModelId)
        : null;
    if (
        matchingModel
        && (isClaude1mModelId(normalizeModelId(matchingModel.id)) || descriptionSuggestsClaude1m(matchingModel.description))
    ) {
        return CLAUDE_1M_CONTEXT_WINDOW_TOKENS;
    }

    return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function resolveContextWarningWindowTokens(params: Readonly<{
    agentId: AgentId;
    metadata: Metadata | null | undefined;
    usageData?: ContextUsageData;
}>): number | null {
    const contextWindowTokens = resolveContextWindowTokens(params);
    return contextWindowTokens === null ? null : toContextWarningWindowTokens(contextWindowTokens);
}
