import type { AgentId } from '@/agents/catalog/catalog';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { resolveMachineAgentState } from '@/agents/machineAgents/resolveMachineAgentState';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';
import type { DaemonMergedProjectionPhase } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resolveAgentSessionStartBlock, resolveMachineAgentStatus } from '@/components/machines/agents/machineAgentPresentation';
import { formatMachineAgentStatus } from '@/components/machines/agents/machineAgentCopy';
import { t } from '@/text';

export type NewSessionSelectableBackendEntry = Pick<
    ResolvedBackendCatalogEntry,
    'backendTarget' | 'backendTargetKey' | 'builtInAgentId' | 'agentId' | 'kind' | 'capabilities'
>;

type BaseSelectionParams = Readonly<{
    machineAgentsById: Readonly<Record<string, MachineAgent | undefined>>;
}>;

/** Launch admission is separate from picker eligibility and retains unresolved draft intent. */
export function resolveAgentLaunchBlockedReasonForNewSession(params: Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    selectedBackendEntry: NewSessionSelectableBackendEntry | null;
    projectionPhase: DaemonMergedProjectionPhase;
    acpCatalog: AcpCatalogSnapshotV1 | null;
    agentLabel: string;
    selectedCredentialMachineAgent: MachineAgent | null | undefined;
    machineAgentsStatus: MachineAgentsSnapshot['status'];
    agentStartBlock: Readonly<{ text: string }> | null;
}>): string | null {
    if (params.selectedBackendEntry === null) {
        const configuredTarget = params.backendTarget.kind === 'agent'
            ? params.backendTarget.definitionId !== undefined
            : Boolean(params.backendTarget.configuredBackendId);
        const catalogLoading = configuredTarget
            ? params.acpCatalog === null || params.acpCatalog.status === 'loading'
            : params.projectionPhase === 'loading';
        return catalogLoading ? t('machineAgents.checking') : t('newSession.selectAiBackendTitle');
    }
    return params.selectedBackendEntry.capabilities?.session?.supported === false ? `${params.agentLabel} · ${t('common.unavailable')}`
        : params.selectedBackendEntry.kind === 'configuredBackend'
            || resolveAgentSessionStartBlock(params.selectedCredentialMachineAgent ?? null) === null ? null
        : params.agentStartBlock?.text ?? `${params.agentLabel} · ${formatMachineAgentStatus(resolveMachineAgentStatus(
            params.selectedCredentialMachineAgent ?? null, undefined, params.machineAgentsStatus,
        ))}`;
}

export type NewSessionProfileAvailabilityReason =
    | 'no-supported-cli'
    | 'cli-not-detected:any'
    | `cli-not-detected:${AgentId}`
    | 'agent-not-ready:any'
    | `agent-not-ready:${AgentId}`
    | 'logged-out:any'
    | `logged-out:${AgentId}`;

/** Choosing an executable is not credential admission; Start checks the exact binding. */
function isAgentExecutableSelectable(agent: MachineAgent | undefined): boolean {
    if (resolveAgentSessionStartBlock(agent ?? null) === null) return true;
    if (!agent || agent.state !== 'needsSignIn') return false;
    return resolveAgentSessionStartBlock({ ...agent, state: resolveMachineAgentState({ ...agent, authenticationRequired: false }) }) === null;
}

function resolveAgentUnavailabilityReasonForNewSession(
    params: BaseSelectionParams & Readonly<{ agentId: AgentId }>,
): Exclude<NewSessionProfileAvailabilityReason, 'no-supported-cli' | 'cli-not-detected:any' | 'agent-not-ready:any' | 'logged-out:any'> | null {
    const agent = params.machineAgentsById[params.agentId];
    if (isAgentExecutableSelectable(agent)) return null;
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
    return isAgentExecutableSelectable(params.machineAgentsById[params.agentId]);
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
