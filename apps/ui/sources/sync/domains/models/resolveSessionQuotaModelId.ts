import type { AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { matchesSessionControlProvider, readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';

/** Resolve the model used by the quota gauge without changing the user's picker choice. */
/** Resolves Default to provider-matched runtime metadata while preserving an explicit picker choice. */
export function resolveSessionQuotaModelId(params: Readonly<{
    agentId: AgentId;
    modelMode: string | null | undefined;
    metadata: Metadata | null | undefined;
}>): string | null {
    const selectedModelId = params.modelMode?.trim();
    if (selectedModelId && selectedModelId !== 'default') return selectedModelId;

    const models = readSessionModelsState(params.metadata);
    if (!models || !matchesSessionControlProvider({ ...params, provider: models.provider })) return null;
    const currentModelId = models.currentModelId.trim();
    return currentModelId && currentModelId !== 'default' ? currentModelId : null;
}
