import type { AgentType } from '@/sync/domains/models/modelOptions';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { Metadata } from '@happier-dev/session-core/state';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { readAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { hasDynamicModelListForSession, getSelectableModelIdsForSession, supportsFreeformModelSelectionForSession } from '@/sync/domains/models/modelOptions';
import { readSessionModelsState, readSessionModesState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import {
    SessionAppliedModelV1Schema,
    type ProviderBoundModelRef,
} from '@happier-dev/protocol/providers/model-selection';

import { resolveSessionModelSelectionDisposition, type CurrentSessionRunnerProcessIdentity, type SessionModelSelectionDisposition } from './resolveSessionModelSelectionDisposition';

export type ModelApplyScope = 'live' | 'next_prompt' | 'spawn_only';
const StoredSessionAppliedModelV1Schema = createStoredReadSchema(SessionAppliedModelV1Schema);

export type EffectiveModelModeDescription = Readonly<{
    /** Requested model. This owns picker selection and model-specific controls. */
    selectedModelId: string;
    /** Actual runtime model, or retained legacy applied history. */
    appliedModelId: string | null;
    appliedModelStatus: SessionModelSelectionDisposition['reportedSelectionStatus'];
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
    const sessionModels = readSessionModelsState(params.metadata);
    if (sessionModels?.agentId !== undefined) {
        return resolveSessionModelSelectionDisposition({ ...params,
            sessionActive: false, currentRunnerProcessIdentity: null }).lastAppliedSelection;
    }
    // 0.2 persisted catalogs used `provider`, while current catalogs use `agentId`.
    const parsed = StoredSessionAppliedModelV1Schema.safeParse(params.metadata?.sessionAppliedModelV1);
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
    sessionActive?: boolean;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
}): EffectiveModelModeDescription {
    const agentId = typeof params.agentType === 'string' ? params.agentType.trim() : '';
    const staticAgentId = resolveAgentIdFromFlavor(agentId);
    const core = staticAgentId ? getAgentCore(staticAgentId) : null;

    const selectedModelId = normalizeModelId(params.selectedModelId);
    const hasExplicitSelection = selectedModelId.length > 0;
    const defaultModelId = normalizeModelId(core?.model?.defaultMode) || 'default';
    const effectiveModelId = hasExplicitSelection ? selectedModelId : defaultModelId;
    const sessionTarget = resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({
        session: { metadata: params.metadata },
    }));
    const agentTargetKey = sessionTarget
        ? buildBackendTargetKeyV2(sessionTarget)
        : readAgentUniverseBackendTargetKey(agentId);
    const sessionModels = readSessionModelsState(params.metadata);
    const disposition = agentTargetKey === null ? null : resolveSessionModelSelectionDisposition({
        agentId, agentTargetKey, metadata: params.metadata,
        sessionActive: params.sessionActive === true,
        currentRunnerProcessIdentity: params.currentRunnerProcessIdentity ?? null,
    });
    const appliedModelId = sessionModels?.agentId !== undefined
        ? sessionModels.agentId === agentId ? normalizeModelId(sessionModels.currentModelId) || null : null
        : agentTargetKey === null ? null : readAppliedModelSelection({
            agentId, agentTargetKey, metadata: params.metadata,
        })?.modelId ?? null;
    const appliedModelStatus = appliedModelId === null ? null
        : disposition?.reportedSelectionStatus ?? 'last_reported';

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
        appliedModelStatus,
        effectiveModelId,
        applyScope,
        notes,
    };
}
