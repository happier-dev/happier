import {
    writePersistedBackendTargetRefV2,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol';

import {
    isBundledAgentId,
    resolveBundledAgentIdFromContributionIdentity,
    type AgentId,
} from '@/agents/catalog/catalog';

export type LastUsedBackendTargetSettingsDelta = Readonly<{
    lastUsedBackendTarget: PersistedBackendTargetRefV2;
    lastUsedAgent?: AgentId | null;
}>;

/**
 * One writer for the UI-local durable selection. Runtime backend ids stay derived;
 * Oh My Pi persists only its qualified contribution identity.
 */
export function buildLastUsedBackendTargetSettings(params: Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    selectedBuiltInAgentId: AgentId | null;
}>): LastUsedBackendTargetSettingsDelta {
    const lastUsedBackendTarget = params.backendTarget.kind === 'agent'
        ? params.backendTarget
        : writePersistedBackendTargetRefV2(params.backendTarget);
    if (lastUsedBackendTarget.kind === 'agent') {
        const bundledAgentId = resolveBundledAgentIdFromContributionIdentity(lastUsedBackendTarget.identity);
        return {
            // Oh My Pi's released flat id is an import-only predecessor seam.
            // Current writers persist its qualified contribution identity and
            // explicitly clear the retired field instead of recreating it.
            lastUsedAgent: bundledAgentId === 'ohMyPi' ? null : params.selectedBuiltInAgentId,
            lastUsedBackendTarget,
        };
    }
    if (
        params.backendTarget.kind === 'backend'
        && !params.backendTarget.configuredBackendId
        && isBundledAgentId(params.backendTarget.backendId)
    ) {
        return {
            lastUsedAgent: params.selectedBuiltInAgentId ?? params.backendTarget.backendId,
            lastUsedBackendTarget,
        };
    }
    return { lastUsedBackendTarget };
}
