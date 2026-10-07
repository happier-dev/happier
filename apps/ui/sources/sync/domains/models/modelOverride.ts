import { SessionModelSelectionV1Schema, type SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';

import type { Session } from '../state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionModelSelectionIntentFromMetadata } from '@/sync/domains/models/readSessionModelSelectionIntent';

export type ModelOverrideForSpawn = {
    modelSelection: SessionModelSelectionV1;
};

export function getModelOverrideForSpawn(session: Session, agentTargetKey: string): ModelOverrideForSpawn | null {
    const localUpdatedAt = typeof session.modelModeUpdatedAt === 'number'
        && Number.isFinite(session.modelModeUpdatedAt)
        ? session.modelModeUpdatedAt
        : null;
    const metadataIntent = readSessionModelSelectionIntentFromMetadata(
        session.composerOptionsInput === undefined ? readSessionOwnerMetadataView(session) : session.composerOptionsInput,
        agentTargetKey,
    );
    const metadataUpdatedAt = metadataIntent?.updatedAt ?? 0;
    const localModelId = typeof session.modelMode === 'string' ? session.modelMode.trim() : '';
    if (metadataIntent?.selection?.providerConnectionId != null) {
        return {
            modelSelection: SessionModelSelectionV1Schema.parse({
                v: 1,
                updatedAt: metadataIntent.updatedAt,
                ref: metadataIntent.selection,
            }),
        };
    }

    if (localUpdatedAt === null || localUpdatedAt <= metadataUpdatedAt) {
        if (!metadataIntent?.selection) return null;
        return {
            modelSelection: SessionModelSelectionV1Schema.parse({
                v: 1,
                updatedAt: metadataIntent.updatedAt,
                ref: metadataIntent.selection,
            }),
        };
    }

    const modelId = localModelId;
    if (!modelId) return null;

    // Spawn-time override uses `--model <id>`, which must never be the sentinel "default".
    if (modelId === 'default') return null;

    return {
        modelSelection: SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: localUpdatedAt,
            ref: { agentTargetKey, providerConnectionId: null, modelId },
        }),
    };
}
