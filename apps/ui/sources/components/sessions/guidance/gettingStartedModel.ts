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
    sessions: ReadonlyArray<Readonly<{ type: string }>> | null;
    selection: Readonly<{
        activeTarget: Readonly<{ kind: 'server' | 'group'; id: string; groupId?: string }>;
        activeServerId: string;
        allowedServerIds: ReadonlyArray<string>;
    }>;
    serverSelectionGroups: ReadonlyArray<Readonly<{ id: string; name: string }>> | null | undefined;
    serverProfiles: ReadonlyArray<Readonly<{ id: string; name: string; serverUrl: string }>>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<Readonly<{ active: boolean }>> | null | undefined>>;
    machineListStatusByServerId: Readonly<Record<string, MachineListStatus | undefined>>;
}>;

export type SessionGettingStartedViewModel = Readonly<{
    kind: SessionGettingStartedDecisionKind;
    targetLabel: string;
    serverId: string;
    serverName: string;
    serverUrl: string;
    showServerSetup: boolean;
}>;

function countSessionItems(items: ReadonlyArray<Readonly<{ type: string }>>): number {
    let count = 0;
    for (const item of items) {
        if (item.type === 'session') count += 1;
    }
    return count;
}

function resolveActiveServerProfile(
    serverProfiles: ReadonlyArray<Readonly<{ id: string; name: string; serverUrl: string }>>,
    activeServerId: string,
): { serverId: string; serverName: string; serverUrl: string } {
    const byId = new Map(serverProfiles.map((p) => [p.id, p] as const));
    const match = byId.get(activeServerId) ?? serverProfiles[0] ?? null;
    if (match) {
        return { serverId: match.id, serverName: match.name, serverUrl: match.serverUrl };
    }
    return { serverId: activeServerId, serverName: activeServerId || 'server', serverUrl: '' };
}

function resolveTargetLabel(input: SessionGettingStartedViewModelInput, activeServerName: string): string {
    const target = input.selection.activeTarget;
    if (target.kind !== 'group') return activeServerName;
    const groupId = String(target.groupId ?? target.id ?? '').trim();
    const groups = input.serverSelectionGroups ?? [];
    const match = groups.find((g) => String(g.id ?? '').trim() === groupId) ?? null;
    return match?.name ?? 'Selected servers';
}

export function buildSessionGettingStartedViewModel(input: SessionGettingStartedViewModelInput): SessionGettingStartedViewModel {
    const activeProfile = resolveActiveServerProfile(input.serverProfiles, input.selection.activeServerId);
    const targetLabel = resolveTargetLabel(input, activeProfile.serverName);

    const perServer = input.selection.allowedServerIds.map((serverId) => {
        if (!Object.prototype.hasOwnProperty.call(input.machineListByServerId, serverId)) {
            return { machineCount: null, onlineCount: null };
        }
        const list = input.machineListByServerId[serverId];
        if (!Array.isArray(list)) {
            return { machineCount: null, onlineCount: null };
        }
        const online = list.filter((m) => m.active === true).length;
        return { machineCount: list.length, onlineCount: online };
    });
    const machines = computeMachinesSummary(perServer);

    const sessionsReady = input.sessions !== null;
    const sessionCount = input.sessions ? countSessionItems(input.sessions) : 0;

    const kind = computeSessionGettingStartedDecision({
        sessionsReady,
        sessionCount,
        machines,
    });

    const showServerSetup = Boolean(activeProfile.serverUrl) && activeProfile.serverUrl !== 'https://api.happier.dev';

    return {
        kind,
        targetLabel,
        serverId: activeProfile.serverId,
        serverName: activeProfile.serverName,
        serverUrl: activeProfile.serverUrl,
        showServerSetup,
    };
}
