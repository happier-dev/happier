import { isNativeAutomaticModelSelectionInputV1, SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { isSessionModelRefSourceBound, type SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';

import type { Session } from '../state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionModelSelectionFromMetadata, readSessionModelSelectionIntentFromMetadata } from '@/sync/domains/models/readSessionModelSelectionIntent';

export type ModelOverrideForSpawn = {
    modelSelection: SessionModelSelection;
};

export function getModelOverrideForSpawn(session: Session, agentTargetKey: string): ModelOverrideForSpawn | null {
    const choice = readSessionModelAuthoringChoice(session, agentTargetKey);
    return choice?.modelSelection ? { modelSelection: choice.modelSelection } : null;
}

export function readSessionModelAuthoringChoice(session: Session, agentTargetKey: string): Readonly<{
    modelSelection: SessionModelSelection | null;
    updatedAt: number;
}> | undefined {
    const localUpdatedAt = typeof session.modelModeUpdatedAt === 'number'
        && Number.isFinite(session.modelModeUpdatedAt)
        ? session.modelModeUpdatedAt
        : null;
    const metadata = session.composerOptionsInput === undefined ? readSessionOwnerMetadataView(session) : session.composerOptionsInput;
    const metadataSelection = readSessionModelSelectionFromMetadata(metadata, agentTargetKey);
    // Only the deployed V1 clear has a clock without a selection.
    const metadataUpdatedAt = metadataSelection?.updatedAt
        ?? readSessionModelSelectionIntentFromMetadata(metadata, agentTargetKey)?.updatedAt;
    const localModelId = typeof session.modelMode === 'string' ? session.modelMode.trim() : '';
    if (metadataSelection && isSessionModelRefSourceBound(metadataSelection.ref)) {
        return { modelSelection: metadataSelection, updatedAt: metadataSelection.updatedAt };
    }

    if (localUpdatedAt === null || localUpdatedAt <= (metadataUpdatedAt ?? 0)) {
        if (metadataUpdatedAt === undefined) return undefined;
        const modelSelection = metadataSelection && !isNativeAutomaticModelSelectionInputV1({ modelId: metadataSelection.ref.modelId })
            ? metadataSelection : null;
        return { modelSelection, updatedAt: metadataUpdatedAt };
    }

    if (!localModelId) return undefined;
    if (isNativeAutomaticModelSelectionInputV1({ modelId: localModelId })) {
        return { modelSelection: null, updatedAt: localUpdatedAt };
    }

    return {
        updatedAt: localUpdatedAt,
        modelSelection: SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: localUpdatedAt,
            ref: { agentTargetKey, providerConnectionId: null, modelId: localModelId },
        }),
    };
}
