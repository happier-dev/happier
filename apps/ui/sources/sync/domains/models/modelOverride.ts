import { resolveMetadataStringOverrideV1 } from '@happier-dev/agents';

import type { Session } from '../state/storageTypes';

export type ModelOverrideForSpawn = {
    modelId: string;
    modelUpdatedAt: number;
};

export function getModelOverrideForSpawn(session: Session): ModelOverrideForSpawn | null {
    const localUpdatedAt = session.modelModeUpdatedAt;
    if (typeof localUpdatedAt !== 'number') return null;

    const metadataOverride = resolveMetadataStringOverrideV1(session.metadata as any, 'modelOverrideV1', 'modelId');
    const metadataUpdatedAt = metadataOverride?.updatedAt ?? 0;
    if (localUpdatedAt <= metadataUpdatedAt) return null;

    const modelId = typeof session.modelMode === 'string' ? session.modelMode.trim() : '';
    if (!modelId) return null;

    // Spawn-time override uses `--model <id>`, which must never be the sentinel "default".
    if (modelId === 'default') return null;

    return { modelId, modelUpdatedAt: localUpdatedAt };
}

