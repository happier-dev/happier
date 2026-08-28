import type { AgentId } from '@/agents/catalog/catalog';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { CliAuthStatusData } from '@/sync/api/capabilities/capabilitiesProtocol';

type AgentAvailabilityById = Readonly<Partial<Record<AgentId, boolean | null>>>;
type AgentAuthStatusById = Readonly<Partial<Record<AgentId, CliAuthStatusData | null>>>;
type InstallableDepKeyCountByAgentId = Readonly<Partial<Record<AgentId, number>>>;
type SelectableWithoutCliByAgentId = Readonly<Partial<Record<AgentId, boolean>>>;

export type NewSessionSelectableBackendEntry = Pick<
    ResolvedBackendCatalogEntry,
    'backendTarget' | 'backendTargetKey' | 'builtInAgentId' | 'agentId' | 'kind'
    | 'capabilities'
>;

type BaseSelectionParams = Readonly<{
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    authStatusById?: AgentAuthStatusById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>;

export type NewSessionProfileAvailabilityReason =
    | 'no-supported-cli'
    | 'cli-not-detected:any'
    | `cli-not-detected:${AgentId}`
    | 'logged-out:any'
    | `logged-out:${AgentId}`;

function resolveAgentUnavailabilityReasonForNewSession(params: Readonly<{
    agentId: AgentId;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    authStatusById?: AgentAuthStatusById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): Exclude<NewSessionProfileAvailabilityReason, 'no-supported-cli' | 'cli-not-detected:any' | 'logged-out:any'> | null {
    if (params.detectionTimestamp <= 0) return null;
    if (params.authStatusById?.[params.agentId]?.state === 'logged_out') {
        return params.selectableWithoutCliByAgentId?.[params.agentId] === true
            ? null
            : `logged-out:${params.agentId}`;
    }
    if (params.availabilityById[params.agentId] === true) return null;
    if (params.selectableWithoutCliByAgentId?.[params.agentId] === true) return null;
    if ((params.installableDepKeyCountByAgentId[params.agentId] ?? 0) > 0) return null;
    return `cli-not-detected:${params.agentId}`;
}

export function resolveBackendEntryUnavailabilityReasonForNewSession(params: Readonly<{
    entry: NewSessionSelectableBackendEntry;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    authStatusById?: AgentAuthStatusById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): NewSessionProfileAvailabilityReason | null {
    if (params.entry.capabilities?.session?.supported === false) {
        return 'no-supported-cli';
    }
    if (params.entry.kind === 'configuredBackend') {
        return null;
    }
    const agentId = params.entry.kind === 'pluginBackend'
        ? params.entry.agentId
        : params.entry.builtInAgentId;
    if (!agentId) {
        return null;
    }
    return resolveAgentUnavailabilityReasonForNewSession({
        agentId,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        authStatusById: params.authStatusById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
    });
}

export function isAgentSelectableForNewSession(params: Readonly<{
    agentId: AgentId;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    authStatusById?: AgentAuthStatusById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): boolean {
    return resolveAgentUnavailabilityReasonForNewSession(params) === null;
}

export function getSelectableAgentIdsForNewSession(params: Readonly<{
    candidateAgentIds: ReadonlyArray<AgentId>;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    authStatusById?: AgentAuthStatusById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): AgentId[] {
    return params.candidateAgentIds.filter((agentId) => isAgentSelectableForNewSession({
        agentId,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        authStatusById: params.authStatusById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
    }));
}

export function isBackendEntrySelectableForNewSession(params: Readonly<{
    entry: NewSessionSelectableBackendEntry;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    authStatusById?: AgentAuthStatusById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): boolean {
    return resolveBackendEntryUnavailabilityReasonForNewSession(params) === null;
}

export function getSelectableBackendEntriesForNewSession(params: Readonly<{
    candidateBackendEntries: ReadonlyArray<NewSessionSelectableBackendEntry>;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    authStatusById?: AgentAuthStatusById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): NewSessionSelectableBackendEntry[] {
    return params.candidateBackendEntries.filter((entry) => isBackendEntrySelectableForNewSession({
        entry,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        authStatusById: params.authStatusById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
    }));
}

export function resolveProfileAvailabilityForNewSession(params: Readonly<{
    candidateBackendEntries: ReadonlyArray<NewSessionSelectableBackendEntry>;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    authStatusById?: AgentAuthStatusById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): { available: boolean; reason?: NewSessionProfileAvailabilityReason } {
    if (params.candidateBackendEntries.length === 0) {
        return { available: false, reason: 'no-supported-cli' };
    }
    if (params.candidateBackendEntries.length === 1) {
        const requiredEntry = params.candidateBackendEntries[0];
        const unavailabilityReason = resolveBackendEntryUnavailabilityReasonForNewSession({
            entry: requiredEntry,
            detectionTimestamp: params.detectionTimestamp,
            availabilityById: params.availabilityById,
            authStatusById: params.authStatusById,
            installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
        });
        if (unavailabilityReason) {
            return { available: false, reason: unavailabilityReason };
        }
        return { available: true };
    }

    const unavailabilityReasons = params.candidateBackendEntries
        .map((entry) => resolveBackendEntryUnavailabilityReasonForNewSession({
            entry,
            detectionTimestamp: params.detectionTimestamp,
            availabilityById: params.availabilityById,
            authStatusById: params.authStatusById,
            installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
        }))
        .filter((reason): reason is NewSessionProfileAvailabilityReason => reason !== null);
    if (unavailabilityReasons.length === params.candidateBackendEntries.length) {
        const hasCliNotDetected = unavailabilityReasons.some((reason) => reason.startsWith('cli-not-detected:'));
        const hasOnlyUnsupportedSessionBackends = unavailabilityReasons.every((reason) => reason === 'no-supported-cli');
        if (hasOnlyUnsupportedSessionBackends) {
            return { available: false, reason: 'no-supported-cli' };
        }
        return { available: false, reason: hasCliNotDetected ? 'cli-not-detected:any' : 'logged-out:any' };
    }
    return { available: true };
}

export function resolveNextSelectableBackendEntryForNewSession(params: Readonly<{
    candidateBackendEntries: ReadonlyArray<NewSessionSelectableBackendEntry>;
    currentTargetKey: string;
    detectionTimestamp: number;
    availabilityById: AgentAvailabilityById;
    authStatusById?: AgentAuthStatusById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): NewSessionSelectableBackendEntry | null {
    const candidates = params.candidateBackendEntries;
    if (candidates.length === 0) return null;

    const selectableEntries = getSelectableBackendEntriesForNewSession({
        candidateBackendEntries: candidates,
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        authStatusById: params.authStatusById,
        installableDepKeyCountByAgentId: params.installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId: params.selectableWithoutCliByAgentId,
    });
    if (selectableEntries.length === 0) return null;

    const currentIndex = selectableEntries.findIndex((entry) => entry.backendTargetKey === params.currentTargetKey);
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
    authStatusById?: AgentAuthStatusById;
    installableDepKeyCountByAgentId: InstallableDepKeyCountByAgentId;
    selectableWithoutCliByAgentId?: SelectableWithoutCliByAgentId;
}>): AgentId | null {
    const candidates = params.candidateAgentIds;
    if (candidates.length === 0) return null;
    const baseParams: BaseSelectionParams = {
        detectionTimestamp: params.detectionTimestamp,
        availabilityById: params.availabilityById,
        authStatusById: params.authStatusById,
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
