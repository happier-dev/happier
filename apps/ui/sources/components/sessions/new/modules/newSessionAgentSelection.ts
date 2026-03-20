import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';

type AgentAvailabilityById = Readonly<Partial<Record<AgentId, boolean | null>>>;
type InstallableDepKeyCountByAgentId = Readonly<Partial<Record<AgentId, number>>>;
type SelectableWithoutCliByAgentId = Readonly<Partial<Record<AgentId, boolean>>>;
export type NewSessionSelectableBackendEntry = Readonly<{
    target: BackendTargetRefV1;
    targetKey: string;
    builtInAgentId: AgentId | null;
    family: 'builtInAgent' | 'configuredAcpBackend';
}>;
type BaseSelectionParams = Readonly<{
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
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
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): boolean {
    if (params.detectionTimestamp <= 0) return true;
    if (params.availabilityById[params.agentId] === true) return true;
    if (params.selectableWithoutCliByAgentId?.[params.agentId] === true) return true;
    return (params.installableDepKeyCountByAgentId[params.agentId] ?? 0) > 0;
}

export function getSelectableAgentIdsForNewSession(params: Readonly<{
    candidateAgentIds: ReadonlyArray<AgentId>;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): AgentId[] {
    return params.candidateAgentIds.filter((agentId) => isAgentSelectableForNewSession({
        agentId,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
    }));
}

export function isBackendEntrySelectableForNewSession(params: Readonly<{
    entry: NewSessionSelectableBackendEntry;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): boolean {
    if (params.entry.family === 'configuredAcpBackend') {
        return true;
    }
    if (!params.entry.builtInAgentId) {
        return true;
    }
    return isAgentSelectableForNewSession({
        agentId: params.entry.builtInAgentId,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
    });
}

export function getSelectableBackendEntriesForNewSession(params: Readonly<{
    candidateBackendEntries: ReadonlyArray<NewSessionSelectableBackendEntry>;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): NewSessionSelectableBackendEntry[] {
    return params.candidateBackendEntries.filter((entry) => isBackendEntrySelectableForNewSession({
        entry,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
    }));
}

export function resolveProfileAvailabilityForNewSession(params: Readonly<{
    candidateBackendEntries: ReadonlyArray<NewSessionSelectableBackendEntry>;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): { available: boolean; reason?: NewSessionProfileAvailabilityReason } {
    if (params.candidateBackendEntries.length === 0) {
        return { available: false, reason: 'no-supported-cli' };
    }
    if (params.candidateBackendEntries.length === 1) {
        const requiredEntry = params.candidateBackendEntries[0];
        const selectable = isBackendEntrySelectableForNewSession({
            entry: requiredEntry,
            detectionTimestamp: params.detectionTimestamp,
            availabilityById: params.availabilityById,
            installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
        });
        if (!selectable) {
            return {
                available: false,
                reason: requiredEntry.builtInAgentId ? `cli-not-detected:${requiredEntry.builtInAgentId}` : 'cli-not-detected:any',
            };
        }
        return { available: true };
    }

    const selectableEntries = getSelectableBackendEntriesForNewSession({
        candidateBackendEntries: params.candidateBackendEntries,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
    });
    if (selectableEntries.length === 0) {
        return { available: false, reason: 'cli-not-detected:any' };
    }
    return { available: true };
}

export function resolveNextSelectableBackendEntryForNewSession(params: Readonly<{
    candidateBackendEntries: ReadonlyArray<NewSessionSelectableBackendEntry>;
    currentTargetKey: string;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): NewSessionSelectableBackendEntry | null {
    const candidates = params.candidateBackendEntries;
    if (candidates.length === 0) return null;

    const selectableEntries = getSelectableBackendEntriesForNewSession({
        candidateBackendEntries: candidates,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
    });
    if (selectableEntries.length === 0) return null;

    const currentIndex = selectableEntries.findIndex((entry) => entry.targetKey === params.currentTargetKey);
    if (currentIndex < 0) {
        return selectableEntries[0] ?? null;
    }
    return selectableEntries[(currentIndex + 1) % selectableEntries.length] ?? null;
}

export function resolveNextSelectableAgentForNewSession(params: Readonly<{
    candidateAgentIds: ReadonlyArray<AgentId>;
    currentAgentId: AgentId;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): AgentId | null {
    const candidates = params.candidateAgentIds;
    if (candidates.length === 0) return null;
    const baseParams: BaseSelectionParams = {
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
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
