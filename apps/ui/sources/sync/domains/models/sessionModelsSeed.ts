import type { Metadata } from '@/sync/domains/state/storageTypes';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import type { PreflightModelList } from './modelOptions';

type SessionModelsSeed = Readonly<{
    agentId: string;
    currentModelId: string;
    availableModels: NonNullable<Metadata['sessionModelsV1']>['availableModels'];
    updatedAt: number;
}>;

function readNonBlank(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

export function buildSessionModelsSeedRequest(params: Readonly<{
    agentId: string;
    currentTargetKey: string | null;
    preflightTargetKey: string | null;
    preflightModels: PreflightModelList | null | undefined;
    currentModelId: string;
    hasCuratedStaticModels: boolean;
    updatedAt: number;
}>): SessionModelsSeed | null {
    if (
        params.hasCuratedStaticModels
        || !params.currentTargetKey
        || params.preflightTargetKey !== params.currentTargetKey
        || params.preflightModels?.unavailable === true
    ) {
        return null;
    }
    const agentId = readNonBlank(params.agentId);
    const currentModelId = readNonBlank(params.currentModelId);
    if (!agentId || !currentModelId) return null;

    const availableModels = (params.preflightModels?.availableModels ?? []).flatMap((model) => {
        const id = readNonBlank(model.id);
        const name = readNonBlank(model.name);
        if (!id || !name) return [];
        const description = readNonBlank(model.description);
        const extendedContextModelId = readNonBlank(model.extendedContextModelId);
        return [{
            id,
            name,
            ...(description ? { description } : {}),
            ...(extendedContextModelId ? { extendedContextModelId } : {}),
            ...(model.modelOptions?.length ? { modelOptions: [...model.modelOptions] } : {}),
        }];
    });
    if (availableModels.length === 0) return null;

    return {
        agentId,
        currentModelId,
        availableModels,
        updatedAt: params.updatedAt,
    };
}

export function computeNextSessionModelsSeedMetadata(params: Readonly<{
    metadata: Metadata;
    seed: SessionModelsSeed;
}>): Metadata {
    if (readSessionModelsState(params.metadata) !== null) return params.metadata;
    const state = { v: 1 as const, ...params.seed };
    return {
        ...params.metadata,
        sessionModelsV1: state,
        acpSessionModelsV1: state,
    };
}

export async function publishSessionModelsSeedToMetadata(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    seed: SessionModelsSeed;
    updateSessionMetadataWithRetry: (
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
        options?: Readonly<{ serverId?: string | null }>,
    ) => Promise<void>;
}>): Promise<void> {
    await params.updateSessionMetadataWithRetry(
        params.sessionId,
        (metadata) => computeNextSessionModelsSeedMetadata({ metadata, seed: params.seed }),
        { serverId: params.serverId },
    );
}
