import type { AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { matchesSessionControlProvider, readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { getAgentStaticModels, providers as agentProviders } from '@happier-dev/agents';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = agentProviders.claude.CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
export const CLAUDE_1M_CONTEXT_WINDOW_TOKENS = agentProviders.claude.CLAUDE_1M_CONTEXT_WINDOW_TOKENS;
const CONTEXT_WARNING_WINDOW_RATIO = 0.95;

function normalizeModelId(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function normalizeContextWindowTokens(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
}

function descriptionSuggestsClaude1m(description: unknown): boolean {
    if (typeof description !== 'string') return false;
    const normalized = description.trim().toLowerCase();
    return normalized.includes('1 million') || normalized.includes('1m context');
}

function resolveCatalogContextWindowTokens(agentId: AgentId, modelId: string): number | null {
    if (!modelId) return null;
    const staticModels = getAgentStaticModels(agentId);
    const directMatch = staticModels.find((model) => normalizeModelId(model.id) === modelId) ?? null;
    if (directMatch) {
        return normalizeContextWindowTokens(directMatch.contextWindowTokens);
    }

    const normalizedKey = modelId.replace(/\./g, '-');
    const normalizedMatch = staticModels.find((model) => {
        const idKey = normalizeModelId(model.id).replace(/\./g, '-');
        return idKey === normalizedKey || normalizedKey.startsWith(`${idKey}-`);
    });
    return normalizeContextWindowTokens(normalizedMatch?.contextWindowTokens);
}

export function toContextWarningWindowTokens(contextWindowTokens: number): number {
    return Math.max(1, Math.floor(contextWindowTokens * CONTEXT_WARNING_WINDOW_RATIO));
}

type ContextUsageData = Readonly<{
    contextSize?: number;
    contextWindowTokens?: number;
}> | null | undefined;

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
    if (sessionModelsState && matchesSessionControlProvider({ ...params, provider: sessionModelsState.provider })) {
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

    // Claude model-id facts (any `[1m]` variant, always-1M base ids) own the next resolution step.
    const overrideModelWindowTokens = agentProviders.claude.resolveClaudeContextWindowTokensForModelId(overrideModelId);
    if (overrideModelWindowTokens !== null) return overrideModelWindowTokens;

    if (!sessionModelsState || sessionModelsState.provider !== 'claude') {
        return DEFAULT_CONTEXT_WINDOW_TOKENS;
    }

    const currentModelId = normalizeModelId(sessionModelsState.currentModelId);
    const currentModelWindowTokens = agentProviders.claude.resolveClaudeContextWindowTokensForModelId(currentModelId);
    if (currentModelWindowTokens !== null) return currentModelWindowTokens;

    const matchingModel = Array.isArray(sessionModelsState.availableModels)
        ? sessionModelsState.availableModels.find((model) => normalizeModelId(model.id) === currentModelId)
        : null;
    if (
        matchingModel &&
        (agentProviders.claude.isClaude1mModelId(normalizeModelId(matchingModel.id)) || descriptionSuggestsClaude1m(matchingModel.description))
    ) {
        return CLAUDE_1M_CONTEXT_WINDOW_TOKENS;
    }

    return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function resolveContextWindowTokens(params: Readonly<{
    agentId: AgentId;
    metadata: Metadata | null | undefined;
    usageData?: ContextUsageData;
}>): number | null {
    const assumedContextWindowTokens = resolveAssumedContextWindowTokens(params);
    if (assumedContextWindowTokens === null) return null;
    if (params.agentId !== 'claude') return assumedContextWindowTokens;

    // Evidence fallback: observed usage beyond the assumed window proves the assumption stale
    // (e.g. 1M enabled in Claude's own settings without Happier knowing). Bump along the known
    // Claude window ladder instead of trusting the stale value.
    const observedUsedTokens = typeof params.usageData?.contextSize === 'number'
        ? params.usageData.contextSize
        : 0;
    return agentProviders.claude.bumpClaudeContextWindowTokensForObservedUsage({
        contextWindowTokens: assumedContextWindowTokens,
        observedUsedTokens,
    });
}

export function resolveContextWarningWindowTokens(params: Readonly<{
    agentId: AgentId;
    metadata: Metadata | null | undefined;
    usageData?: ContextUsageData;
}>): number | null {
    const contextWindowTokens = resolveContextWindowTokens(params);
    return contextWindowTokens === null ? null : toContextWarningWindowTokens(contextWindowTokens);
}
