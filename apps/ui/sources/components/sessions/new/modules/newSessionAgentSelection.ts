import type { AgentId } from '@/agents/catalog/catalog';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { isMachineAgentReady } from '@/agents/machineAgents/resolveMachineAgentState';

export type NewSessionSelectableBackendEntry = Pick<
    ResolvedBackendCatalogEntry,
    'backendTarget' | 'backendTargetKey' | 'builtInAgentId' | 'agentId' | 'kind' | 'capabilities'
>;

type BaseSelectionParams = Readonly<{
    machineAgentsById: Readonly<Record<string, MachineAgent | undefined>>;
}>;

export type NewSessionProfileAvailabilityReason =
    | 'no-supported-cli'
    | 'cli-not-detected:any'
    | `cli-not-detected:${AgentId}`
    | 'agent-not-ready:any'
    | `agent-not-ready:${AgentId}`
    | 'logged-out:any'
    | `logged-out:${AgentId}`;

function resolveAgentUnavailabilityReasonForNewSession(
    params: BaseSelectionParams & Readonly<{ agentId: AgentId }>,
): Exclude<NewSessionProfileAvailabilityReason, 'no-supported-cli' | 'cli-not-detected:any' | 'agent-not-ready:any' | 'logged-out:any'> | null {
    const agent = params.machineAgentsById[params.agentId];
    if (isMachineAgentReady(agent)) return null;
    if (!agent || agent.stale) return `agent-not-ready:${params.agentId}`;
    if (agent.state === 'needsSignIn') return `logged-out:${params.agentId}`;
    return agent.state === 'notInstalled' && !agent.installed
        ? `cli-not-detected:${params.agentId}`
        : `agent-not-ready:${params.agentId}`;
}

export function resolveBackendEntryUnavailabilityReasonForNewSession(
    params: BaseSelectionParams & Readonly<{ entry: NewSessionSelectableBackendEntry }>,
): NewSessionProfileAvailabilityReason | null {
    if (params.entry.capabilities?.session?.supported === false) return 'no-supported-cli';
    if (params.entry.kind === 'configuredBackend') return null;

    const agentId = params.entry.kind === 'pluginBackend' ? params.entry.agentId : params.entry.builtInAgentId;
    if (!agentId) return 'no-supported-cli';
    return resolveAgentUnavailabilityReasonForNewSession({ agentId, machineAgentsById: params.machineAgentsById });
}

export function isAgentSelectableForNewSession(
    params: BaseSelectionParams & Readonly<{ agentId: AgentId }>,
): boolean {
    return isMachineAgentReady(params.machineAgentsById[params.agentId]);
}

export function getSelectableAgentIdsForNewSession(
    params: BaseSelectionParams & Readonly<{ candidateAgentIds: ReadonlyArray<AgentId> }>,
): AgentId[] {
    return params.candidateAgentIds.filter((agentId) => isAgentSelectableForNewSession({
        agentId, machineAgentsById: params.machineAgentsById,
    }));
}

export function isBackendEntrySelectableForNewSession(
    params: BaseSelectionParams & Readonly<{ entry: NewSessionSelectableBackendEntry }>,
): boolean {
    return resolveBackendEntryUnavailabilityReasonForNewSession(params) === null;
}

export function getSelectableBackendEntriesForNewSession(
    params: BaseSelectionParams & Readonly<{ candidateBackendEntries: ReadonlyArray<NewSessionSelectableBackendEntry> }>,
): NewSessionSelectableBackendEntry[] {
    return params.candidateBackendEntries.filter((entry) => isBackendEntrySelectableForNewSession({
        entry, machineAgentsById: params.machineAgentsById,
    }));
}

export function resolveProfileAvailabilityForNewSession(
    params: BaseSelectionParams & Readonly<{ candidateBackendEntries: ReadonlyArray<NewSessionSelectableBackendEntry> }>,
): { available: boolean; reason?: NewSessionProfileAvailabilityReason } {
    if (params.candidateBackendEntries.length === 0) return { available: false, reason: 'no-supported-cli' };

    const unavailabilityReasons = params.candidateBackendEntries.map((entry) =>
        resolveBackendEntryUnavailabilityReasonForNewSession({ entry, machineAgentsById: params.machineAgentsById }),
    );
    if (unavailabilityReasons.some((reason) => reason === null)) return { available: true };
    if (unavailabilityReasons.length === 1) {
        return { available: false, reason: unavailabilityReasons[0] ?? 'no-supported-cli' };
    }
    if (unavailabilityReasons.every((reason) => reason === 'no-supported-cli')) {
        return { available: false, reason: 'no-supported-cli' };
    }
    return {
        available: false,
        reason: unavailabilityReasons.some((reason) => reason?.startsWith('agent-not-ready:'))
            ? 'agent-not-ready:any'
            : unavailabilityReasons.some((reason) => reason?.startsWith('cli-not-detected:'))
            ? 'cli-not-detected:any'
            : 'logged-out:any',
    };
}

export function resolveNextSelectableBackendEntryForNewSession(
    params: BaseSelectionParams & Readonly<{
        candidateBackendEntries: ReadonlyArray<NewSessionSelectableBackendEntry>;
        currentTargetKey: string;
    }>,
): NewSessionSelectableBackendEntry | null {
    const selectableEntries = getSelectableBackendEntriesForNewSession(params);
    if (selectableEntries.length === 0) return null;

    const currentIndex = selectableEntries.findIndex((entry) => entry.backendTargetKey === params.currentTargetKey);
    return selectableEntries[(currentIndex + 1) % selectableEntries.length] ?? null;
}

export function resolveNextSelectableAgentForNewSession(
    params: BaseSelectionParams & Readonly<{
        candidateAgentIds: ReadonlyArray<AgentId>;
        currentAgentId: AgentId;
    }>,
): AgentId | null {
    const candidates = params.candidateAgentIds;
    const currentIndex = candidates.indexOf(params.currentAgentId);
    for (let step = 1; step <= candidates.length; step += 1) {
        const agentId = candidates[(currentIndex + step) % candidates.length];
        if (agentId && isAgentSelectableForNewSession({ agentId, machineAgentsById: params.machineAgentsById })) {
            return agentId;
        }
    }
    return null;
}
