import {
    writePersistedBackendTargetRefV2,
    type BackendTargetRefV2,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol';

import { isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';

export type LastUsedBackendTargetSettingsDelta = Readonly<{
    lastUsedBackendTarget: PersistedBackendTargetRefV2;
    lastUsedAgent?: AgentId | null;
}>;

/**
 * One writer for the UI-local durable selection. Runtime backend ids stay derived;
 * Oh My Pi persists only its qualified contribution identity.
 */
export function buildLastUsedBackendTargetSettings(params: Readonly<{
    backendTarget: BackendTargetRefV2;
    selectedBuiltInAgentId: AgentId | null;
}>): LastUsedBackendTargetSettingsDelta {
    const lastUsedBackendTarget = writePersistedBackendTargetRefV2(params.backendTarget);
    if (lastUsedBackendTarget.kind === 'agent') {
        return {
            lastUsedAgent: null,
            lastUsedBackendTarget,
        };
    }
    if (!params.backendTarget.configuredBackendId && isBundledAgentId(params.backendTarget.backendId)) {
        return {
            lastUsedAgent: params.selectedBuiltInAgentId ?? params.backendTarget.backendId,
            lastUsedBackendTarget,
        };
    }
    return { lastUsedBackendTarget };
}
