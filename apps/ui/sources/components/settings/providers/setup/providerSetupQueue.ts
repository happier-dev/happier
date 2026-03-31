import type { AgentId } from '@/agents/catalog/catalog';

export type ProviderSetupQueueState = Readonly<{
    activeProviderId: AgentId | null;
    completedProviderIds: AgentId[];
    failedProviderIds: AgentId[];
    pendingProviderIds: AgentId[];
    skippedProviderIds?: AgentId[];
}>;

export function createProviderSetupQueueState(providerIds: readonly AgentId[]): ProviderSetupQueueState {
    const [activeProviderId = null, ...pendingProviderIds] = providerIds;
    return {
        activeProviderId,
        completedProviderIds: [],
        failedProviderIds: [],
        pendingProviderIds: [...pendingProviderIds],
    };
}

export function createProviderSetupQueueStateFromInstallSummary(params: Readonly<{
    selectedProviderIds: readonly AgentId[];
    installedProviderIds: readonly AgentId[];
    failedProviderIds: readonly AgentId[];
}>): ProviderSetupQueueState {
    const installedProviderIdSet = new Set(params.installedProviderIds);
    const failedProviderIdSet = new Set(params.failedProviderIds);
    const orderedInstalledProviderIds = params.selectedProviderIds.filter((providerId) => installedProviderIdSet.has(providerId));
    const orderedFailedProviderIds = params.selectedProviderIds.filter((providerId) => failedProviderIdSet.has(providerId));

    const queueState = createProviderSetupQueueState(orderedInstalledProviderIds);
    return orderedFailedProviderIds.length > 0
        ? {
            ...queueState,
            failedProviderIds: orderedFailedProviderIds,
        }
        : queueState;
}

export function completeActiveProviderSetupStep(state: ProviderSetupQueueState): ProviderSetupQueueState {
    if (!state.activeProviderId) {
        return state;
    }

    const [nextActiveProviderId = null, ...pendingProviderIds] = state.pendingProviderIds;
    return {
        activeProviderId: nextActiveProviderId,
        completedProviderIds: [...state.completedProviderIds, state.activeProviderId],
        failedProviderIds: [...state.failedProviderIds],
        pendingProviderIds,
        ...(state.skippedProviderIds?.length ? { skippedProviderIds: [...state.skippedProviderIds] } : {}),
    };
}

export function failActiveProviderSetupStep(state: ProviderSetupQueueState): ProviderSetupQueueState {
    if (!state.activeProviderId) {
        return state;
    }

    const [nextActiveProviderId = null, ...pendingProviderIds] = state.pendingProviderIds;
    return {
        activeProviderId: nextActiveProviderId,
        completedProviderIds: [...state.completedProviderIds],
        failedProviderIds: [...state.failedProviderIds, state.activeProviderId],
        pendingProviderIds,
        ...(state.skippedProviderIds?.length ? { skippedProviderIds: [...state.skippedProviderIds] } : {}),
    };
}

export function markActiveProviderSetupStepFailed(state: ProviderSetupQueueState): ProviderSetupQueueState {
    if (!state.activeProviderId) {
        return state;
    }

    if (state.failedProviderIds.includes(state.activeProviderId)) {
        return state;
    }

    return {
        ...state,
        failedProviderIds: [...state.failedProviderIds, state.activeProviderId],
    };
}

export function skipActiveProviderSetupStep(state: ProviderSetupQueueState): ProviderSetupQueueState {
    if (!state.activeProviderId) {
        return state;
    }

    const [nextActiveProviderId = null, ...pendingProviderIds] = state.pendingProviderIds;
    return {
        activeProviderId: nextActiveProviderId,
        completedProviderIds: [...state.completedProviderIds],
        failedProviderIds: [...state.failedProviderIds],
        pendingProviderIds,
        skippedProviderIds: [...(state.skippedProviderIds ?? []), state.activeProviderId],
    };
}
