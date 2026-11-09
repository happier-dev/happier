import type { Metadata } from '@happier-dev/session-core/state';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import type { AcpConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import type { PreflightModelList } from './modelOptions';

type StoredSessionModelList = NonNullable<Metadata['sessionModelsV1']>['availableModels'];
type StoredModelOption = NonNullable<StoredSessionModelList[number]['modelOptions']>[number];

type SessionModelsSeed = Readonly<{
    agentId: string;
    currentModelId: string;
    availableModels: StoredSessionModelList;
    updatedAt: number;
}>;

/**
 * Project a preflight catalog's model options onto the shape session metadata persists.
 *
 * The catalog publishes readonly option data it keeps owning, while metadata is a mutable
 * document handed to every later writer, so the nested arrays are copied rather than aliased.
 * Display groups and their flattened selection index remain part of that same projection.
 */
function toStoredModelOptions(options: readonly AcpConfigOption[]): StoredModelOption[] {
    return options.map(({ options: choices, groups, overridesWhenOn, ...option }) => ({
        ...option,
        ...(choices ? { options: choices.map((choice) => ({ ...choice })) } : {}),
        ...(groups ? { groups: groups.map((group) => ({ ...group, options: group.options.map((choice) => ({ ...choice })) })) } : {}),
        ...(overridesWhenOn
            ? { overridesWhenOn: { ...overridesWhenOn, optionIds: [...overridesWhenOn.optionIds] } }
            : {}),
    }));
}

function readNonBlank(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return value.trim().length > 0 ? value : null;
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
            ...(model.modelOptions?.length ? { modelOptions: toStoredModelOptions(model.modelOptions) } : {}),
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
