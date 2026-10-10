import { DEFAULT_HAPPIER_CLOUD_SERVER_URL } from '@happier-dev/cli-common/happierCloud';

import { resolveHomeTargetSummary } from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { computeMachinesSummary, type MachinesSummary } from './computeMachinesSummary';

export { computeMachinesSummary, type MachinesSummary } from './computeMachinesSummary';

export type SessionGettingStartedDecisionKind =
    | 'loading'
    | 'connect_machine'
    | 'start_daemon'
    | 'create_session'
    | 'select_session';

export type ServerTargetLabel = Readonly<{
    kind: 'server' | 'group';
    label: string;
}>;

export type MachineListStatus = 'idle' | 'loading' | 'signedOut' | 'error';

export function computeSessionGettingStartedDecision(params: Readonly<{
    sessionsReady: boolean;
    sessionCount: number;
    machines: MachinesSummary;
}>): SessionGettingStartedDecisionKind {
    if (!params.sessionsReady) return 'loading';
    if (params.machines.machineCount === 0 && params.machines.hasUnknownServers) {
        if (params.sessionCount > 0) return 'select_session';
        return 'loading';
    }
    if (params.machines.machineCount === 0) return 'connect_machine';
    if (params.sessionCount > 0) return 'select_session';
    if (params.machines.onlineCount === 0) return 'start_daemon';
    if (params.sessionCount === 0) return 'create_session';
    return 'select_session';
}

export type SessionGettingStartedViewModelInput = Readonly<{
    sessionsReady: boolean;
    sessionCount: number;
    activeMachines: ReadonlyArray<Readonly<{ active: boolean; revokedAt?: number | null }>>;
    selection: Readonly<{
        activeTarget: Readonly<{ kind: 'server' | 'group'; id: string; groupId?: string }>;
        activeServerId: string;
        allowedServerIds: ReadonlyArray<string>;
    }>;
    serverSelectionGroups: ReadonlyArray<Readonly<{ id: string; name: string }>> | null | undefined;
    activeServerProfile: Readonly<{
        id: string;
        name: string;
        serverUrl: string;
        serverIdentityId?: string | null;
        legacyServerIds?: readonly string[];
    }>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<Readonly<{ active: boolean; revokedAt?: number | null }>> | null | undefined>>;
    /** Each Home's machine-list status: the per-Home reachability fact the Homes status also reads. */
    machineListStatusByServerId?: Readonly<Record<string, MachineListStatus | undefined>>;
}>;

export type SessionGettingStartedViewModel = Readonly<{
    kind: SessionGettingStartedDecisionKind;
    /** Selected Homes that are not answering (or need sign-in): reported, never waited on. */
    unavailableServerIds: readonly string[];
    targetLabel: string;
    serverId: string;
    serverName: string;
    serverUrl: string;
    showServerSetup: boolean;
}>;

type SessionGettingStartedServerProfile = Readonly<{
    id: string;
    name: string;
    serverUrl: string;
    serverIdentityId?: string | null;
    legacyServerIds?: readonly string[];
}>;

export type SessionGettingStartedMachinesInput = Readonly<{
    activeMachines: SessionGettingStartedViewModelInput['activeMachines'];
    selection: SessionGettingStartedViewModelInput['selection'];
    activeServerProfile?: SessionGettingStartedViewModelInput['activeServerProfile'] | null;
    machineListByServerId: SessionGettingStartedViewModelInput['machineListByServerId'];
    machineListStatusByServerId?: SessionGettingStartedViewModelInput['machineListStatusByServerId'];
}>;

export type SessionGettingStartedMachinesResolution = MachinesSummary & Readonly<{
    unavailableServerIds: readonly string[];
}>;

/** Same reading as the Homes status: a Home whose projection failed, or needs sign-in, is not answering. */
function isHomeUnavailable(status: MachineListStatus | undefined): boolean {
    const kind = resolveHomeTargetSummary({ authStatus: 'unknown', projectionStatus: status }).kind;
    return kind === 'unavailable' || kind === 'sign_in';
}

function resolveActiveProfileServerIdAliases(
    profile: SessionGettingStartedViewModelInput['activeServerProfile'] | null | undefined,
    serverId: string,
): readonly string[] {
    if (!profile) return [];
    const normalizedServerId = String(serverId ?? '').trim();
    const candidates = [
        profile.id,
        profile.serverIdentityId ?? '',
        ...(profile.legacyServerIds ?? []),
    ]
        .map((candidate) => String(candidate ?? '').trim())
        .filter((candidate, index, candidates) => candidate.length > 0 && candidates.indexOf(candidate) === index);
    if (!normalizedServerId || !candidates.includes(normalizedServerId)) return [];
    return candidates.filter((candidate) => candidate !== normalizedServerId);
}

export function resolveActiveServerProfile(
    serverProfiles: ReadonlyArray<SessionGettingStartedServerProfile>,
    activeServerId: string,
): SessionGettingStartedViewModelInput['activeServerProfile'] {
    const normalizedActiveServerId = String(activeServerId ?? '').trim();
    const directMatch = normalizedActiveServerId
        ? serverProfiles.find((profile) => profile.id === normalizedActiveServerId) ?? null
        : null;
    const aliasMatch = normalizedActiveServerId
        ? serverProfiles.find((profile) => {
            if (profile.serverIdentityId === normalizedActiveServerId) return true;
            return Boolean(profile.legacyServerIds?.includes(normalizedActiveServerId));
        }) ?? null
        : null;
    const match = directMatch ?? aliasMatch ?? serverProfiles[0] ?? null;
    if (match) {
        return {
            id: match.id,
            name: match.name,
            serverUrl: match.serverUrl,
            serverIdentityId: match.serverIdentityId ?? null,
            legacyServerIds: match.legacyServerIds ?? [],
        };
    }
    return { id: activeServerId, name: activeServerId || 'server', serverUrl: '' };
}

function resolveTargetLabel(input: SessionGettingStartedViewModelInput, activeServerName: string): string {
    const target = input.selection.activeTarget;
    if (target.kind !== 'group') return activeServerName;
    const groupId = String(target.groupId ?? target.id ?? '').trim();
    const groups = input.serverSelectionGroups ?? [];
    const match = groups.find((g) => String(g.id ?? '').trim() === groupId) ?? null;
    return match?.name ?? 'Selected servers';
}

/**
 * Only the signed-in account's machine list says which machines are the user's. A daemon running on
 * this computer is not counted: it may be signed in to another account or serve another Home, and
 * the shared this-computer connection owner explains that state instead.
 */
export function resolveSessionGettingStartedMachinesSummary(input: SessionGettingStartedMachinesInput): SessionGettingStartedMachinesResolution {
    const machinesFor = (serverId: string) => resolveServerScopedMachines({
        serverId,
        activeServerId: input.selection.activeServerId,
        serverIdAliases: resolveActiveProfileServerIdAliases(input.activeServerProfile, serverId),
        activeMachines: input.activeMachines,
        machineListByServerId: input.machineListByServerId,
        machineListStatusByServerId: input.machineListStatusByServerId,
    });
    // A Home that is not answering never holds the decision: it is reported, and the Homes that
    // answer (or the active Home) decide.
    const unavailableServerIds = input.selection.allowedServerIds.filter((serverId) => (
        !machinesFor(serverId) && isHomeUnavailable(input.machineListStatusByServerId?.[serverId])
    ));
    const selectedServerIds = input.selection.allowedServerIds.filter((serverId) => !unavailableServerIds.includes(serverId));
    const activeServerMachines = resolveServerScopedMachines({
        serverId: input.selection.activeServerId,
        activeServerId: input.selection.activeServerId,
        serverIdAliases: resolveActiveProfileServerIdAliases(input.activeServerProfile, input.selection.activeServerId),
        activeMachines: input.activeMachines,
        machineListByServerId: input.machineListByServerId,
        machineListStatusByServerId: input.machineListStatusByServerId,
    });
    const perServer = selectedServerIds.map((serverId) => {
        const machines = resolveServerScopedMachines({
            serverId,
            activeServerId: input.selection.activeServerId,
            serverIdAliases: resolveActiveProfileServerIdAliases(input.activeServerProfile, serverId),
            activeMachines: input.activeMachines,
            machineListByServerId: input.machineListByServerId,
            machineListStatusByServerId: input.machineListStatusByServerId,
        });
        if (!machines) {
            return { machineCount: null, onlineCount: null };
        }
        const online = machines.filter((m) => m.active === true).length;
        return { machineCount: machines.length, onlineCount: online };
    });
    const selectedMachines = computeMachinesSummary(perServer);
    const activeServerSummary = activeServerMachines
        ? {
            machineCount: activeServerMachines.length,
            onlineCount: activeServerMachines.filter((machine) => machine.active === true).length,
        }
        : null;
    if (selectedServerIds.length === 0 && unavailableServerIds.length > 0) {
        return {
            ...(activeServerSummary
                ? { hasUnknownServers: false, machineCount: activeServerSummary.machineCount, onlineCount: activeServerSummary.onlineCount }
                : { hasUnknownServers: true, machineCount: 0, onlineCount: 0 }),
            unavailableServerIds,
        };
    }
    const machines = selectedMachines.machineCount > 0
        ? selectedMachines
        : !selectedMachines.hasUnknownServers && activeServerSummary && activeServerSummary.machineCount && activeServerSummary.machineCount > 0
            ? {
                hasUnknownServers: false,
                machineCount: activeServerSummary.machineCount,
                onlineCount: activeServerSummary.onlineCount ?? 0,
            }
            : selectedMachines;

    return { ...machines, unavailableServerIds };
}

export function buildSessionGettingStartedViewModel(input: SessionGettingStartedViewModelInput): SessionGettingStartedViewModel {
    const activeProfile = input.activeServerProfile;
    const targetLabel = resolveTargetLabel(input, activeProfile.name);
    const machines = resolveSessionGettingStartedMachinesSummary(input);

    const kind = computeSessionGettingStartedDecision({
        sessionsReady: input.sessionsReady,
        sessionCount: input.sessionCount,
        machines,
    });

    const showServerSetup = Boolean(activeProfile.serverUrl) && activeProfile.serverUrl !== DEFAULT_HAPPIER_CLOUD_SERVER_URL;

    return {
        kind,
        unavailableServerIds: machines.unavailableServerIds,
        targetLabel,
        serverId: activeProfile.id,
        serverName: activeProfile.name,
        serverUrl: activeProfile.serverUrl,
        showServerSetup,
    };
}
