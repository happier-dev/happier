import type { AgentId } from '@/agents/catalog/catalog';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { resolveSessionModelSelectionDisposition } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import type { CurrentSessionRunnerProcessIdentity } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { getAgentStaticModels } from '@happier-dev/agents';
import {
    readSessionProviderBindingMetadataV1,
    type SessionContextUsageSnapshotV1,
} from '@happier-dev/protocol';

const CONTEXT_WARNING_WINDOW_RATIO = 0.95;

function normalizeModelId(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function normalizeContextWindowTokens(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
}

function resolveCatalogContextWindowTokens(agentId: AgentId, modelId: string): number | null {
    if (!modelId) return null;
    const matchingModel = getAgentStaticModels(agentId)
        .find((model) => normalizeModelId(model.id) === modelId) ?? null;
    return normalizeContextWindowTokens(matchingModel?.contextWindowTokens);
}

function resolveBehaviorContextWindowTokensForModel(
    agentId: AgentId,
    model: Readonly<{ id?: unknown; description?: unknown }> | null | undefined,
): number | null {
    const modelId = normalizeModelId(model?.id);
    if (!modelId) return null;
    return normalizeContextWindowTokens(resolveAgentUiBehavior(agentId).contextWindow?.getContextWindowTokensForModel?.({
        modelId,
        description: model?.description,
    }));
}

export function toContextWarningWindowTokens(contextWindowTokens: number): number {
    return Math.max(1, Math.floor(contextWindowTokens * CONTEXT_WARNING_WINDOW_RATIO));
}

type ContextUsageData = Readonly<{
    contextWindowTokens?: number;
    contextSize?: number;
    contextSnapshot?: SessionContextUsageSnapshotV1;
}> | null | undefined;

export function resolveContextWindowTokens(params: Readonly<{
    agentId: AgentId;
    agentTargetKey?: string | null;
    metadata: Metadata | null | undefined;
    sessionActive?: boolean;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
    usageData?: ContextUsageData;
}>): number | null {
    const snapshotContextWindowTokens = normalizeContextWindowTokens(
        params.usageData?.contextSnapshot?.windowTokens,
    );
    if (snapshotContextWindowTokens !== null) {
        return snapshotContextWindowTokens;
    }

    const liveContextWindowTokens = normalizeContextWindowTokens(params.usageData?.contextWindowTokens);
    if (liveContextWindowTokens !== null) {
        return liveContextWindowTokens;
    }

    const assumed = resolveAssumedContextWindowTokens(params);
    const bumpForObservedUsage = resolveAgentUiBehavior(params.agentId).contextWindow?.bumpContextWindowTokensForObservedUsage;
    return assumed === null || !bumpForObservedUsage
        ? assumed
        : bumpForObservedUsage({
            contextWindowTokens: assumed,
            observedUsedTokens: params.usageData?.contextSize,
        });
}

function resolveAssumedContextWindowTokens(params: Readonly<{
    agentId: AgentId;
    agentTargetKey?: string | null;
    metadata: Metadata | null | undefined;
    sessionActive?: boolean;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
    usageData?: ContextUsageData;
}>): number | null {
    if (typeof params.sessionActive !== 'boolean') {
        return null;
    }
    const agentTargetKey = params.agentTargetKey ?? buildAgentUniverseBackendTargetKey(params.agentId);
    const disposition = resolveSessionModelSelectionDisposition({
        agentId: params.agentId,
        agentTargetKey,
        metadata: params.metadata,
        sessionActive: params.sessionActive,
        currentRunnerProcessIdentity: params.currentRunnerProcessIdentity ?? null,
    });
    const contextSelection = disposition.contextSelection;
    if (params.sessionActive && contextSelection === null) {
        return null;
    }
    const providerBinding = readSessionProviderBindingMetadataV1(params.metadata);
    const sessionModelsState = readSessionModelsState(params.metadata);
    const selectedModelId = normalizeModelId(contextSelection?.modelId);
    if (contextSelection !== null && contextSelection.providerConnectionId !== null) {
        const bindingModel = providerBinding?.connectionId === contextSelection.providerConnectionId
            && normalizeModelId(providerBinding.model?.id) === selectedModelId
            ? providerBinding.model
            : null;
        const bindingContextWindowTokens = normalizeContextWindowTokens(bindingModel?.contextWindowTokens);
        if (bindingContextWindowTokens !== null) return bindingContextWindowTokens;
        if (!sessionModelsState || sessionModelsState.agentId !== params.agentId) return null;
        const selectedProviderModel = Array.isArray(sessionModelsState.availableModels)
            ? sessionModelsState.availableModels.find(
                (model) => normalizeModelId(model.id) === selectedModelId,
            )
            : null;
        return normalizeContextWindowTokens(selectedProviderModel?.contextWindowTokens);
    }

    if (sessionModelsState && sessionModelsState.agentId === params.agentId) {
        const matchingModel = Array.isArray(sessionModelsState.availableModels)
            ? sessionModelsState.availableModels.find((model) => normalizeModelId(model.id) === selectedModelId)
            : null;
        const contextWindowTokens = normalizeContextWindowTokens(matchingModel?.contextWindowTokens)
            ?? resolveBehaviorContextWindowTokensForModel(params.agentId, matchingModel);
        if (contextWindowTokens !== null) {
            return contextWindowTokens;
        }
    }

    const behaviorContextWindowTokens = resolveBehaviorContextWindowTokensForModel(
        params.agentId,
        { id: selectedModelId },
    );
    if (behaviorContextWindowTokens !== null) {
        return behaviorContextWindowTokens;
    }

    return resolveCatalogContextWindowTokens(params.agentId, selectedModelId)
        ?? normalizeContextWindowTokens(
            resolveAgentUiBehavior(params.agentId).contextWindow?.getDefaultContextWindowTokens?.(),
        );
}

export function resolveContextWarningWindowTokens(params: Readonly<{
    agentId: AgentId;
    agentTargetKey?: string | null;
    metadata: Metadata | null | undefined;
    sessionActive?: boolean;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
    usageData?: ContextUsageData;
}>): number | null {
    const contextWindowTokens = resolveContextWindowTokens(params);
    return contextWindowTokens === null ? null : toContextWarningWindowTokens(contextWindowTokens);
}
