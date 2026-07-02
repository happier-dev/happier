import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';

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

export type MachinesSummary = Readonly<{
    hasUnknownServers: boolean;
    machineCount: number;
    onlineCount: number;
}>;

export function computeMachinesSummary(
    servers: ReadonlyArray<Readonly<{ machineCount: number | null; onlineCount: number | null }>>,
): MachinesSummary {
    let hasUnknownServers = false;
    let machineCount = 0;
    let onlineCount = 0;
    for (const server of servers) {
        if (server.machineCount === null || server.onlineCount === null) {
            hasUnknownServers = true;
            continue;
        }
        machineCount += server.machineCount;
        onlineCount += server.onlineCount;
    }
    return { hasUnknownServers, machineCount, onlineCount };
}

export function computeSessionGettingStartedDecision(params: Readonly<{
    sessionsReady: boolean;
    sessionCount: number;
    machines: MachinesSummary;
}>): SessionGettingStartedDecisionKind {
    if (!params.sessionsReady) return 'loading';
    if (params.machines.machineCount === 0 && params.machines.hasUnknownServers) {
        return 'loading';
    }
    if (params.machines.machineCount === 0) return 'connect_machine';
    if (params.machines.onlineCount === 0) return 'start_daemon';
    if (params.sessionCount === 0) return 'create_session';
    return 'select_session';
}

export type SessionGettingStartedViewModelInput = Readonly<{
    sessionsReady: boolean;
    sessionCount: number;
    activeMachines: ReadonlyArray<Readonly<{ active: boolean; revokedAt?: number | null }>>;
    localDaemonStatus?: Readonly<{
        serviceInstalled: boolean;
        daemonRunning: boolean;
        needsAuth: boolean;
        machineId: string | null;
    }> | null;
    selection: Readonly<{
        activeTarget: Readonly<{ kind: 'server' | 'group'; id: string; groupId?: string }>;
        activeServerId: string;
        allowedServerIds: ReadonlyArray<string>;
    }>;
    serverSelectionGroups: ReadonlyArray<Readonly<{ id: string; name: string }>> | null | undefined;
    activeServerProfile: Readonly<{ id: string; name: string; serverUrl: string }>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<Readonly<{ active: boolean; revokedAt?: number | null }>> | null | undefined>>;
}>;

export type SessionGettingStartedViewModel = Readonly<{
    kind: SessionGettingStartedDecisionKind;
    targetLabel: string;
    serverId: string;
    serverName: string;
    serverUrl: string;
    showServerSetup: boolean;
}>;

export type SessionGettingStartedMachinesInput = Readonly<{
    activeMachines: SessionGettingStartedViewModelInput['activeMachines'];
    localDaemonStatus?: SessionGettingStartedViewModelInput['localDaemonStatus'];
    selection: SessionGettingStartedViewModelInput['selection'];
    machineListByServerId: SessionGettingStartedViewModelInput['machineListByServerId'];
}>;

function hasHealthyLocalDaemon(status: SessionGettingStartedViewModelInput['localDaemonStatus']): boolean {
    return status?.serviceInstalled === true
        && status?.daemonRunning === true
        && status?.needsAuth !== true
        && typeof status?.machineId === 'string'
        && status.machineId.trim().length > 0;
}

function applyLocalDaemonHealthHint(
    summary: Readonly<{ machineCount: number | null; onlineCount: number | null }>,
    localDaemonHealthy: boolean,
): Readonly<{ machineCount: number | null; onlineCount: number | null }> {
    if (!localDaemonHealthy) {
        return summary;
    }
    if (summary.machineCount === null || summary.onlineCount === null) {
        return summary;
    }
    return {
        machineCount: Math.max(summary.machineCount, 1),
        onlineCount: Math.max(summary.onlineCount, 1),
    };
}

export function resolveActiveServerProfile(
    serverProfiles: ReadonlyArray<Readonly<{ id: string; name: string; serverUrl: string }>>,
    activeServerId: string,
): { id: string; name: string; serverUrl: string } {
    const byId = new Map(serverProfiles.map((p) => [p.id, p] as const));
    const match = byId.get(activeServerId) ?? serverProfiles[0] ?? null;
    if (match) {
        return { id: match.id, name: match.name, serverUrl: match.serverUrl };
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

export function resolveSessionGettingStartedMachinesSummary(input: SessionGettingStartedMachinesInput): MachinesSummary {
    const localDaemonHealthy = hasHealthyLocalDaemon(input.localDaemonStatus);

    const selectedServerIds = input.selection.allowedServerIds;
    const activeServerMachines = resolveServerScopedMachines({
        serverId: input.selection.activeServerId,
        activeServerId: input.selection.activeServerId,
        activeMachines: input.activeMachines,
        machineListByServerId: input.machineListByServerId,
    });
    const perServer = selectedServerIds.map((serverId) => {
        const machines = resolveServerScopedMachines({
            serverId,
            activeServerId: input.selection.activeServerId,
            activeMachines: input.activeMachines,
            machineListByServerId: input.machineListByServerId,
        });
        if (!machines) {
            return { machineCount: null, onlineCount: null };
        }
        const online = machines.filter((m) => m.active === true).length;
        return applyLocalDaemonHealthHint(
            { machineCount: machines.length, onlineCount: online },
            serverId === input.selection.activeServerId && localDaemonHealthy,
        );
    });
    const selectedMachines = computeMachinesSummary(perServer);
    const activeServerSummary = activeServerMachines
        ? applyLocalDaemonHealthHint(
            {
                machineCount: activeServerMachines.length,
                onlineCount: activeServerMachines.filter((machine) => machine.active === true).length,
            },
            localDaemonHealthy,
        )
        : null;
    const machines = selectedMachines.machineCount > 0
        ? selectedMachines
        : !selectedMachines.hasUnknownServers && activeServerSummary && activeServerSummary.machineCount && activeServerSummary.machineCount > 0
            ? {
                hasUnknownServers: false,
                machineCount: activeServerSummary.machineCount,
                onlineCount: activeServerSummary.onlineCount ?? 0,
            }
            : selectedMachines;

    return machines;
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

    const showServerSetup = Boolean(activeProfile.serverUrl) && activeProfile.serverUrl !== 'https://api.happier.dev';

    return {
        kind,
        targetLabel,
        serverId: activeProfile.id,
        serverName: activeProfile.name,
        serverUrl: activeProfile.serverUrl,
        showServerSetup,
    };
}
