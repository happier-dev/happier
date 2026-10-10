import type { AgentType } from '@/sync/domains/models/modelOptions';
import type { Metadata } from '@happier-dev/session-core/state';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { hasDynamicModelListForSession, getSelectableModelIdsForSession, supportsFreeformModelSelectionForSession } from '@/sync/domains/models/modelOptions';
import { readSessionModelsState, readSessionModesState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import {
    SessionAppliedModelV1Schema,
    type ProviderBoundModelRef,
} from '@happier-dev/protocol/providers/model-selection';

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

export function readAppliedModelSelection(params: Readonly<{
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
    composerOptionsInput?: ComposerOptionsInputV1 | null;
}): EffectiveModelModeDescription {
    const agentId = typeof params.agentType === 'string' ? params.agentType.trim() : '';
    const staticAgentId = resolveAgentIdFromFlavor(agentId);
    const core = staticAgentId ? getAgentCore(staticAgentId) : null;

    const selectedModelId = normalizeModelId(params.selectedModelId);
    const hasExplicitSelection = selectedModelId.length > 0;
    const defaultModelId = normalizeModelId(core?.model?.defaultMode) || 'default';
    const effectiveModelId = hasExplicitSelection ? selectedModelId : defaultModelId;
    const appliedModelId = readAppliedModelSelection({
        agentId,
        agentTargetKey: buildAgentUniverseBackendTargetKey(agentId),
        metadata: params.metadata,
    })?.modelId ?? null;

    const composerOptionsInput = params.composerOptionsInput === undefined ? params.metadata : params.composerOptionsInput;
    const isAcpSession = Boolean(readSessionModesState(params.metadata) || readSessionModelsState(composerOptionsInput));

    let applyScope: ModelApplyScope = isAcpSession ? 'live' : (core?.model?.nonAcpApplyScope ?? 'next_prompt');
    const notes: string[] = [];

    // When a model change takes effect is `applyScope`, not prose: the surface
    // renders that fact as one localized line. Only facts `applyScope` cannot
    // express stay here, so a picker never has a paragraph to show.
    if (applyScope === 'live' && core?.model?.acpApplyBehavior === 'restart_session') {
        notes.push('This provider restarts the underlying session when switching models (context is preserved when possible).');
    }

    const hasDynamicList = hasDynamicModelListForSession(agentId, composerOptionsInput);
    if (hasExplicitSelection && !hasDynamicList && supportsFreeformModelSelectionForSession(agentId, composerOptionsInput)) {
        const known = getSelectableModelIdsForSession(agentId, composerOptionsInput);
        if (!known.includes(effectiveModelId)) {
            notes.push('This session accepts custom model IDs (not validated).');
        }
    }

    if (core?.model?.supportsSelection === false && !hasDynamicList) {
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
