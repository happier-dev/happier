import type { Metadata } from '@/sync/domains/state/storageTypes';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import {
    readActiveSessionModelSelectionFromMetadata,
    resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import {
    readSessionProviderBindingMetadataStateV1,
    sessionProviderBindingMetadataMatchesRuntimeBasisV1,
    type ProviderBoundModelRef,
    type SessionModelSelectionIntentV1,
} from '@happier-dev/protocol';

export type CurrentSessionRunnerProcessIdentity = Readonly<{
    pid: number;
    processStartTimeMs: number;
}>;

export type SessionModelSelectionDisposition = Readonly<{
    sessionDisposition: 'active' | 'next_launch';
    proposedIntent: SessionModelSelectionIntentV1 | null;
    proposedSelection: ProviderBoundModelRef | null;
    activeSelection: ProviderBoundModelRef | null;
    selectionTransitionPending: boolean;
    reportedSelection: ProviderBoundModelRef | null;
    reportedSelectionStatus: 'running' | 'last_used' | 'last_reported' | null;
    contextSelection: ProviderBoundModelRef | null;
}>;

function normalizeModelId(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Projects proposed, exact-active, and presentation-only model facts without
 * promoting fallback catalog state into active runtime truth.
 */
export function resolveSessionModelSelectionDisposition(params: Readonly<{
    agentId: string;
    agentTargetKey: string;
    metadata: Metadata | null | undefined;
    sessionActive: boolean;
    currentRunnerProcessIdentity: CurrentSessionRunnerProcessIdentity | null;
}>): SessionModelSelectionDisposition {
    let proposedIntent: SessionModelSelectionIntentV1 | null = null;
    try {
        proposedIntent = resolveModelSelectionIntentFromSessionMetadata(
            params.metadata,
            params.agentTargetKey,
        );
    } catch {
        proposedIntent = null;
    }
    const proposedSelection = proposedIntent?.selection ?? null;

    const providerBindingState = readSessionProviderBindingMetadataStateV1(params.metadata);
    const exactSelection = readActiveSessionModelSelectionFromMetadata(
        params.metadata,
        params.agentTargetKey,
        params.currentRunnerProcessIdentity,
    );

    const sessionModels = readSessionModelsState(params.metadata);
    const fallbackModelId = sessionModels?.agentId === params.agentId
        ? normalizeModelId(sessionModels.currentModelId)
        : '';
    const nativeFallbackSelection: ProviderBoundModelRef = {
        agentTargetKey: params.agentTargetKey,
        providerConnectionId: null,
        modelId: fallbackModelId,
    };
    const providerFallbackSelection: ProviderBoundModelRef | null =
        providerBindingState.kind === 'valid'
        && providerBindingState.binding.model?.id === fallbackModelId
        && sessionProviderBindingMetadataMatchesRuntimeBasisV1({
            selection: {
                agentTargetKey: params.agentTargetKey,
                providerConnectionId: providerBindingState.binding.connectionId,
            },
            binding: providerBindingState.binding,
        })
            ? {
                agentTargetKey: params.agentTargetKey,
                providerConnectionId: providerBindingState.binding.connectionId,
                modelId: fallbackModelId,
            }
            : null;
    const fallbackSelection: ProviderBoundModelRef | null = !fallbackModelId
        ? null
        : providerBindingState.kind === 'absent'
            ? nativeFallbackSelection
            : providerFallbackSelection;
    const reportedSelection = exactSelection ?? fallbackSelection;
    const activeSelection = params.sessionActive ? exactSelection : null;
    const selectionTransitionPending = params.sessionActive
        && proposedIntent !== null
        && (
            activeSelection === null
            || proposedSelection === null
            || activeSelection.agentTargetKey !== proposedSelection.agentTargetKey
            || activeSelection.providerConnectionId !== proposedSelection.providerConnectionId
            || activeSelection.modelId !== proposedSelection.modelId
        );
    const reportedSelectionStatus = reportedSelection === null
        ? null
        : exactSelection !== null
            ? params.sessionActive ? 'running' : 'last_used'
            : 'last_reported';

    return {
        sessionDisposition: params.sessionActive ? 'active' : 'next_launch',
        proposedIntent,
        proposedSelection,
        activeSelection,
        selectionTransitionPending,
        reportedSelection,
        reportedSelectionStatus,
        contextSelection: params.sessionActive
            ? activeSelection
            : proposedSelection ?? reportedSelection,
    };
}
