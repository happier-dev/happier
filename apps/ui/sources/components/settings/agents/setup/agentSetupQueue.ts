export type AgentSetupQueueState = Readonly<{
    activeProviderId: string | null;
    completedProviderIds: string[];
    failedAgentIds: string[];
    pendingProviderIds: string[];
    skippedProviderIds?: string[];
}>;

export function createAgentSetupQueueState(agentIds: readonly string[]): AgentSetupQueueState {
    const [activeProviderId = null, ...pendingProviderIds] = agentIds;
    return {
        activeProviderId,
        completedProviderIds: [],
        failedAgentIds: [],
        pendingProviderIds: [...pendingProviderIds],
    };
}

export function createAgentSetupQueueStateFromInstallSummary(params: Readonly<{
    selectedAgentIds: readonly string[];
    installedAgentIds: readonly string[];
    failedAgentIds: readonly string[];
}>): AgentSetupQueueState {
    const installedProviderIdSet = new Set(params.installedAgentIds);
    const failedProviderIdSet = new Set(params.failedAgentIds);
    const orderedInstalledProviderIds = params.selectedAgentIds.filter((agentId) => installedProviderIdSet.has(agentId));
    const orderedFailedProviderIds = params.selectedAgentIds.filter((agentId) => failedProviderIdSet.has(agentId));

    const queueState = createAgentSetupQueueState(orderedInstalledProviderIds);
    return orderedFailedProviderIds.length > 0
        ? {
            ...queueState,
            failedAgentIds: orderedFailedProviderIds,
        }
        : queueState;
}

export function completeActiveAgentSetupStep(state: AgentSetupQueueState): AgentSetupQueueState {
    if (!state.activeProviderId) {
        return state;
    }

    const [nextActiveProviderId = null, ...pendingProviderIds] = state.pendingProviderIds;
    return {
        activeProviderId: nextActiveProviderId,
        completedProviderIds: [...state.completedProviderIds, state.activeProviderId],
        failedAgentIds: [...state.failedAgentIds],
        pendingProviderIds,
        ...(state.skippedProviderIds?.length ? { skippedProviderIds: [...state.skippedProviderIds] } : {}),
    };
}

export function failActiveAgentSetupStep(state: AgentSetupQueueState): AgentSetupQueueState {
    if (!state.activeProviderId) {
        return state;
    }

    const [nextActiveProviderId = null, ...pendingProviderIds] = state.pendingProviderIds;
    return {
        activeProviderId: nextActiveProviderId,
        completedProviderIds: [...state.completedProviderIds],
        failedAgentIds: [...state.failedAgentIds, state.activeProviderId],
        pendingProviderIds,
        ...(state.skippedProviderIds?.length ? { skippedProviderIds: [...state.skippedProviderIds] } : {}),
    };
}

export function markActiveAgentSetupStepFailed(state: AgentSetupQueueState): AgentSetupQueueState {
    if (!state.activeProviderId) {
        return state;
    }

    if (state.failedAgentIds.includes(state.activeProviderId)) {
        return state;
    }

    return {
        ...state,
        failedAgentIds: [...state.failedAgentIds, state.activeProviderId],
    };
}

export function skipActiveAgentSetupStep(state: AgentSetupQueueState): AgentSetupQueueState {
    if (!state.activeProviderId) {
        return state;
    }

    const [nextActiveProviderId = null, ...pendingProviderIds] = state.pendingProviderIds;
    return {
        activeProviderId: nextActiveProviderId,
        completedProviderIds: [...state.completedProviderIds],
        failedAgentIds: [...state.failedAgentIds],
        pendingProviderIds,
        skippedProviderIds: [...(state.skippedProviderIds ?? []), state.activeProviderId],
    };
}
