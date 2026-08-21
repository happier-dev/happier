import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';

/**
 * Seed the session model list from the new-session wizard's preflight probe.
 *
 * Providers without a static catalog (e.g. Pi) only publish `sessionModelsV1` once their runtime
 * process starts, and runtime start is deferred until the first prompt. Seeding the freshly
 * spawned session with the probe result the user just picked from keeps the in-session model
 * picker populated during that window. The runtime publish stays authoritative: the seed only
 * lands when no model list exists yet, so it can never mask or revert live runtime state.
 */
export function computeNextSessionModelsSeedMetadata(params: Readonly<{
    metadata: Metadata;
    provider: string;
    currentModelId: string;
    availableModels: PreflightModelList['availableModels'];
    updatedAt: number;
}>): Metadata {
    // Seed-only: any existing models state (either metadata alias, any provider) was published by
    // a runtime or inheritance path that owns the truth. The CAS updater re-runs against fresh
    // metadata on version conflicts, so this check also makes a seed that lost the race to the
    // first runtime publish a no-op instead of overwriting it.
    if (readSessionModelsState(params.metadata) !== null) return params.metadata;

    const provider = readNonBlankSessionControlIdentifier(params.provider);
    const currentModelId = readNonBlankSessionControlIdentifier(params.currentModelId);
    if (!provider || !currentModelId) return params.metadata;

    const availableModels = params.availableModels.flatMap((model) => {
        const id = readNonBlankSessionControlIdentifier(model.id);
        const name = readNonBlankSessionControlIdentifier(model.name);
        if (!id || !name) return [];
        const description = typeof model.description === 'string' && model.description.trim().length > 0
            ? model.description
            : null;
        return [{
            id,
            name,
            ...(description ? { description } : {}),
            ...(typeof model.contextWindowTokens === 'number' && Number.isFinite(model.contextWindowTokens) && model.contextWindowTokens > 0
                ? { contextWindowTokens: model.contextWindowTokens }
                : {}),
            ...(readNonBlankSessionControlIdentifier(model.extendedContextModelId)
                ? { extendedContextModelId: model.extendedContextModelId }
                : {}),
            ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0
                ? { modelOptions: model.modelOptions }
                : {}),
        }];
    });
    if (availableModels.length === 0) return params.metadata;

    const seed = {
        v: 1 as const,
        provider,
        updatedAt: params.updatedAt,
        currentModelId,
        availableModels,
    };
    return {
        ...params.metadata,
        sessionModelsV1: seed,
        // Runtime publishes write both aliases; keep the seed at parity so readers on
        // either key observe the same list.
        acpSessionModelsV1: seed,
    };
}

export async function publishSessionModelsSeedToMetadata(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    provider: string;
    currentModelId: string;
    availableModels: PreflightModelList['availableModels'];
    updatedAt: number;
    updateSessionMetadataWithRetry: (
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
        options?: Readonly<{ serverId?: string | null }>,
    ) => Promise<void>;
}>): Promise<void> {
    await params.updateSessionMetadataWithRetry(params.sessionId, (metadata) => computeNextSessionModelsSeedMetadata({
        metadata,
        provider: params.provider,
        currentModelId: params.currentModelId,
        availableModels: params.availableModels,
        updatedAt: params.updatedAt,
    }), { serverId: params.serverId });
}
