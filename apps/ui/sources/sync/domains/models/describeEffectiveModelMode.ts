import type { AgentType } from '@/sync/domains/models/modelOptions';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { hasDynamicModelListForSession, getSelectableModelIdsForSession, supportsFreeformModelSelectionForSession } from '@/sync/domains/models/modelOptions';
import { readSessionModelsState, readSessionModesState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { readSessionAppliedModelMetadataStateV1 } from '@happier-dev/agents';

export type ModelApplyScope = 'live' | 'next_prompt' | 'spawn_only';

export type EffectiveModelModeDescription = Readonly<{
    /** The user-requested model that owns picker selection and the next run/turn. */
    selectedModelId: string;
    /** The latest model accepted for a new provider prompt, when available. */
    appliedModelId: string | null;
    /** @deprecated Use selectedModelId. Retained for internal callers during migration. */
    effectiveModelId: string;
    applyScope: ModelApplyScope;
    notes: string[];
}>;

export function describeEffectiveModelMode(params: {
    agentType: AgentType;
    selectedModelId: string | null | undefined;
    metadata: Metadata | null;
}): EffectiveModelModeDescription {
    const agentId = resolveAgentIdFromFlavor(params.agentType) ?? DEFAULT_AGENT_ID;
    const core = getAgentCore(agentId);

    const selectedModelId = typeof params.selectedModelId === 'string' ? params.selectedModelId.trim() : '';
    const hasExplicitSelection = selectedModelId.length > 0;
    const appliedModelState = readSessionAppliedModelMetadataStateV1(params.metadata);
    const appliedModelId = appliedModelState?.provider === agentId
        ? appliedModelState.modelId.trim()
        : '';
    const resolvedSelectedModelId = hasExplicitSelection ? selectedModelId : core.model.defaultMode;

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
        if (!known.includes(resolvedSelectedModelId)) {
            notes.push('This session accepts custom model IDs (not validated).');
        }
    }

    if (core.model.supportsSelection !== true && !hasDynamicList) {
        notes.push('Model selection is not available in the app for this provider.');
    }

    return {
        selectedModelId: resolvedSelectedModelId,
        appliedModelId: appliedModelId || null,
        effectiveModelId: resolvedSelectedModelId,
        applyScope,
        notes,
    };
}
