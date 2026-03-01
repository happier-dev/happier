import type { Machine } from '@/sync/domains/state/storageTypes';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveMachineIdByHost(hostInput: unknown, machines: ReadonlyArray<Machine>): string | null {
    const host = normalizeNonEmptyString(hostInput);
    if (!host) return null;

    let bestMachineId: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const machine of machines) {
        const machineHost = normalizeNonEmptyString(machine.metadata?.host);
        if (!machineHost || machineHost !== host) continue;
        const score = (machine.active ? 1_000_000_000_000 : 0) + machine.activeAt;
        if (score <= bestScore) continue;
        bestScore = score;
        bestMachineId = machine.id;
    }
    return bestMachineId;
}

function normalizePathForComparison(pathInput: unknown, homeDirInput: unknown): string | null {
    const path = normalizeNonEmptyString(pathInput);
    if (!path) return null;

    const homeDir = normalizeNonEmptyString(homeDirInput);
    let expanded = path;
    if (homeDir && path.startsWith('~')) {
        if (path === '~') {
            expanded = homeDir;
        } else if (path.startsWith('~/') || path.startsWith('~\\')) {
            expanded = `${homeDir}/${path.slice(2)}`;
        }
    }

    const normalized = expanded.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (/^[a-zA-Z]:\/$/.test(normalized)) return normalized;
    if (normalized.length > 1 && normalized.endsWith('/')) return normalized.slice(0, -1);
    return normalized;
}

function resolveSingleMachineFallback(machines: ReadonlyArray<Machine>): string | null {
    const activeMachines = machines.filter((machine) => machine.active);
    if (activeMachines.length === 1) return activeMachines[0]?.id ?? null;
    if (activeMachines.length === 0 && machines.length === 1) return machines[0]?.id ?? null;
    return null;
}

export type SessionMachineTargetPeer = Readonly<{
    id: string;
    active?: boolean;
    updatedAt?: number;
    machineId?: string | null;
    hostHint?: string | null;
    path?: string | null;
    homeDir?: string | null;
    projectMachineId?: string | null;
    projectPath?: string | null;
}>;

export function resolveSessionMachineRpcTarget(input: Readonly<{
    sessionId: string;
    sessionMachineId?: string | null;
    sessionHostHint?: string | null;
    sessionPath?: string | null;
    sessionHomeDir?: string | null;
    projectMachineId?: string | null;
    projectPath?: string | null;
    machines: ReadonlyArray<Machine>;
    peerSessions?: ReadonlyArray<SessionMachineTargetPeer>;
}>): { machineId: string; basePath: string } | null {
    const basePath = normalizeNonEmptyString(input.sessionPath) ?? normalizeNonEmptyString(input.projectPath);
    if (!basePath) return null;

    const machineById = new Set(input.machines.map((machine) => machine.id));
    const knownMachineCandidate = (candidateMachineId: string | null): string | null => {
        if (!candidateMachineId) return null;
        return machineById.has(candidateMachineId) ? candidateMachineId : null;
    };

    const primaryResolved = resolveSessionReachableMachineId({
        machineId: input.sessionMachineId ?? null,
        fallbackMachineId: input.projectMachineId ?? null,
        hostHint: input.sessionHostHint ?? null,
        machines: input.machines,
    });
    const knownPrimary = knownMachineCandidate(primaryResolved);
    if (knownPrimary) {
        return { machineId: knownPrimary, basePath };
    }

    const comparableBasePath = normalizePathForComparison(basePath, input.sessionHomeDir);
    if (comparableBasePath && Array.isArray(input.peerSessions) && input.peerSessions.length > 0) {
        const peers = input.peerSessions
            .filter((peer) => peer.id !== input.sessionId)
            .map((peer) => ({
                ...peer,
                comparablePath:
                    normalizePathForComparison(peer.path ?? null, peer.homeDir ?? null)
                    ?? normalizePathForComparison(peer.projectPath ?? null, peer.homeDir ?? null),
            }))
            .filter((peer) => peer.comparablePath === comparableBasePath)
            .sort((a, b) => {
                const activeDelta = Number(Boolean(b.active)) - Number(Boolean(a.active));
                if (activeDelta !== 0) return activeDelta;
                return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
            });

        for (const peer of peers) {
            const resolved = resolveSessionReachableMachineId({
                machineId: peer.machineId ?? null,
                fallbackMachineId: peer.projectMachineId ?? null,
                hostHint: peer.hostHint ?? null,
                machines: input.machines,
            });
            const knownPeer = knownMachineCandidate(resolved);
            if (knownPeer) {
                return { machineId: knownPeer, basePath };
            }
        }
    }

    const fallbackMachineId = resolveSingleMachineFallback(input.machines);
    if (fallbackMachineId) {
        return { machineId: fallbackMachineId, basePath };
    }

    if (primaryResolved) {
        return { machineId: primaryResolved, basePath };
    }

    return null;
}

export function resolveSessionReachableMachineId(input: Readonly<{
    machineId: string | null | undefined;
    fallbackMachineId?: string | null | undefined;
    hostHint?: string | null | undefined;
    machines: ReadonlyArray<Machine>;
}>): string | null {
    const machineId = normalizeNonEmptyString(input.machineId);
    const fallbackMachineId = normalizeNonEmptyString(input.fallbackMachineId);
    const hostHint = normalizeNonEmptyString(input.hostHint);
    const machineById = new Map(input.machines.map((machine) => [machine.id, machine] as const));

    if (machineId && !machineId.startsWith('host:')) {
        const directMachine = machineById.get(machineId);
        if (directMachine?.active) return machineId;

        const hostCandidate = resolveMachineIdByHost(
            normalizeNonEmptyString(directMachine?.metadata?.host) ?? hostHint,
            input.machines,
        );
        if (hostCandidate) return hostCandidate;
        if (fallbackMachineId && fallbackMachineId !== machineId) return fallbackMachineId;
        return machineId;
    }

    const hostFromMachineId = machineId?.startsWith('host:') ? machineId.slice('host:'.length) : null;
    return resolveMachineIdByHost(hostFromMachineId ?? hostHint, input.machines) ?? fallbackMachineId;
}
