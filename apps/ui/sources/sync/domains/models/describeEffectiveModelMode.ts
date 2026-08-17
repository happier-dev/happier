import type { AgentType } from '@/sync/domains/models/modelOptions';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { hasDynamicModelListForSession, getSelectableModelIdsForSession, supportsFreeformModelSelectionForSession } from '@/sync/domains/models/modelOptions';
import { readSessionModelsState, readSessionModesState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import {
    SessionAppliedModelV1Schema,
    type ProviderBoundModelRef,
} from '@happier-dev/protocol';

export type ModelApplyScope = 'live' | 'next_prompt' | 'spawn_only';

export type EffectiveModelModeDescription = Readonly<{
    /** Requested model. This owns picker selection and model-specific controls. */
    selectedModelId: string;
    /** Last model attached to an exact provider-accepted new turn for this agent. */
    appliedModelId: string | null;
    /** @deprecated Use selectedModelId for selection semantics. */
    effectiveModelId: string;
    applyScope: ModelApplyScope;
    notes: string[];
}>;

function normalizeModelId(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readAppliedModelSelection(params: Readonly<{
    agentId: string;
    agentTargetKey: string;
    metadata: Metadata | null | undefined;
}>): ProviderBoundModelRef | null {
    const parsed = SessionAppliedModelV1Schema.safeParse(params.metadata?.sessionAppliedModelV1);
    if (!parsed.success || parsed.data.provider !== params.agentId) return null;
    const structured = parsed.data.selection;
    if (structured) {
        return structured.agentTargetKey === params.agentTargetKey
            ? structured
            : null;
    }
    return {
        agentTargetKey: params.agentTargetKey,
        providerConnectionId: null,
        modelId: parsed.data.modelId,
    };
}

export function describeEffectiveModelMode(params: {
    agentType: AgentType;
    selectedModelId: string | null | undefined;
    metadata: Metadata | null;
}): EffectiveModelModeDescription {
    const agentId = resolveAgentIdFromFlavor(params.agentType) ?? DEFAULT_AGENT_ID;
    const core = getAgentCore(agentId);

    const selectedModelId = normalizeModelId(params.selectedModelId);
    const hasExplicitSelection = selectedModelId.length > 0;
    const defaultModelId = normalizeModelId(core.model.defaultMode) || 'default';
    const effectiveModelId = hasExplicitSelection ? selectedModelId : defaultModelId;
    const appliedModelId = readAppliedModelSelection({
        agentId,
        agentTargetKey: buildAgentUniverseBackendTargetKey(agentId),
        metadata: params.metadata,
    })?.modelId ?? null;

    const isAcpSession = Boolean(readSessionModesState(params.metadata) || readSessionModelsState(params.metadata));

    let applyScope: ModelApplyScope = isAcpSession ? 'live' : core.model.nonAcpApplyScope;
    const notes: string[] = [];

    // When a model change takes effect is `applyScope`, not prose: the surface
    // renders that fact as one localized line. Only facts `applyScope` cannot
    // express stay here, so a picker never has a paragraph to show.
    if (applyScope === 'live' && core.model.acpApplyBehavior === 'restart_session') {
        notes.push('This provider restarts the underlying session when switching models (context is preserved when possible).');
    }

    const hasDynamicList = hasDynamicModelListForSession(agentId, params.metadata);
    if (hasExplicitSelection && !hasDynamicList && supportsFreeformModelSelectionForSession(agentId, params.metadata)) {
        const known = getSelectableModelIdsForSession(agentId, params.metadata);
        if (!known.includes(effectiveModelId)) {
            notes.push('This session accepts custom model IDs (not validated).');
        }
    }

    if (core.model.supportsSelection !== true && !hasDynamicList) {
        notes.push('Model selection is not available in the app for this provider.');
    }

    return {
        selectedModelId: effectiveModelId,
        appliedModelId,
        effectiveModelId,
        applyScope,
        notes,
    };
}
