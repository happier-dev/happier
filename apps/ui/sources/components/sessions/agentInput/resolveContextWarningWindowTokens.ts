import type { AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';

export const DEFAULT_CONTEXT_WARNING_WINDOW_TOKENS = 190_000;
export const CLAUDE_1M_CONTEXT_WARNING_WINDOW_TOKENS = 950_000;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const CLAUDE_1M_CONTEXT_WINDOW_TOKENS = 1_000_000;
const CONTEXT_WARNING_WINDOW_RATIO = 0.95;

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

export function toContextWarningWindowTokens(contextWindowTokens: number): number {
    return Math.max(1, Math.floor(contextWindowTokens * CONTEXT_WARNING_WINDOW_RATIO));
}

type ContextUsageData = Readonly<{
    contextWindowTokens?: number;
}> | null | undefined;

export function resolveContextWindowTokens(params: Readonly<{
    agentId: AgentId;
    metadata: Metadata | null | undefined;
    usageData?: ContextUsageData;
}>): number | null {
    const liveContextWindowTokens = normalizeContextWindowTokens(params.usageData?.contextWindowTokens);
    if (liveContextWindowTokens !== null) {
        return liveContextWindowTokens;
    }

    const sessionModelsState = readSessionModelsState(params.metadata);
    if (sessionModelsState && sessionModelsState.provider === params.agentId) {
        const overrideModelId = normalizeModelId(params.metadata?.modelOverrideV1?.modelId);
        const activeModelId = overrideModelId || normalizeModelId(sessionModelsState.currentModelId);
        const matchingModel = Array.isArray(sessionModelsState.availableModels)
            ? sessionModelsState.availableModels.find((model) => normalizeModelId(model.id) === activeModelId)
            : null;
        const contextWindowTokens = normalizeContextWindowTokens(matchingModel?.contextWindowTokens);
        if (contextWindowTokens !== null) {
            return contextWindowTokens;
        }
    }

    if (params.agentId !== 'claude') {
        return null;
    }

    const overrideModelId = normalizeModelId(params.metadata?.modelOverrideV1?.modelId);
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
