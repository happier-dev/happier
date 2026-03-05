import type { AgentId } from '@/agents/catalog/catalog';

type AgentAvailabilityById = Readonly<Partial<Record<AgentId, boolean | null>>>;
type InstallableDepKeyCountByAgentId = Readonly<Partial<Record<AgentId, number>>>;
type BaseSelectionParams = Readonly<{
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
}>;

export type NewSessionProfileAvailabilityReason =
    | 'no-supported-cli'
    | 'cli-not-detected:any'
    | `cli-not-detected:${AgentId}`;

export function isAgentSelectableForNewSession(params: Readonly<{
    agentId: AgentId;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
}>): boolean {
    if (params.detectionTimestamp <= 0) return true;
    if (params.availabilityById[params.agentId] !== false) return true;
    return (params.installableDepKeyCountByAgentId[params.agentId] ?? 0) > 0;
}

export function getSelectableAgentIdsForNewSession(params: Readonly<{
    candidateAgentIds: ReadonlyArray<AgentId>;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
}>): AgentId[] {
    return params.candidateAgentIds.filter((agentId) => isAgentSelectableForNewSession({
        agentId,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
    }));
}

export function resolveProfileAvailabilityForNewSession(params: Readonly<{
    supportedAgentIds: ReadonlyArray<AgentId>;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
}>): { available: boolean; reason?: NewSessionProfileAvailabilityReason } {
    if (params.supportedAgentIds.length === 0) {
        return { available: false, reason: 'no-supported-cli' };
    }
    if (params.supportedAgentIds.length === 1) {
        const requiredAgentId = params.supportedAgentIds[0];
        const selectable = isAgentSelectableForNewSession({
            agentId: requiredAgentId,
            detectionTimestamp: params.detectionTimestamp,
            availabilityById: params.availabilityById,
            installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        });
        if (!selectable) {
            return { available: false, reason: `cli-not-detected:${requiredAgentId}` };
        }
        return { available: true };
    }

    const selectableAgentIds = getSelectableAgentIdsForNewSession({
        candidateAgentIds: params.supportedAgentIds,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
    });
    if (selectableAgentIds.length === 0) {
        return { available: false, reason: 'cli-not-detected:any' };
    }
    return { available: true };
}

export function resolveNextSelectableAgentForNewSession(params: Readonly<{
    candidateAgentIds: ReadonlyArray<AgentId>;
    currentAgentId: AgentId;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
}>): AgentId | null {
    const candidates = params.candidateAgentIds;
    if (candidates.length === 0) return null;
    const baseParams: BaseSelectionParams = {
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
    };
    const isSelectable = (agentId: AgentId) => isAgentSelectableForNewSession({ agentId, ...baseParams });

    const currentIndex = candidates.indexOf(params.currentAgentId);
    if (currentIndex < 0) {
        return candidates.find((agentId) => isSelectable(agentId)) ?? null;
    }

    for (let step = 1; step <= candidates.length; step += 1) {
        const idx = (currentIndex + step) % candidates.length;
        const agentId = candidates[idx];
        if (agentId && isSelectable(agentId)) return agentId;
    }

    return null;
}
