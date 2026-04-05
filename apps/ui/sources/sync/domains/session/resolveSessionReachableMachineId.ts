import type { Machine } from '@/sync/domains/state/storageTypes';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export type MachineResolutionContext = Readonly<{
    machineIds: ReadonlySet<string>;
    machineById: ReadonlyMap<string, MachineResolutionCandidate>;
    bestMachineIdByHost: ReadonlyMap<string, string>;
    fallbackMachineId: string | null;
}>;

type MachineResolutionCandidate = Readonly<{
    id?: string | null;
    active?: boolean;
    activeAt?: number | null;
    metadata?: Readonly<{
        host?: string | null;
    }> | null;
}>;

type MutableMachineResolutionContextState = {
    machineIds: Set<string>;
    machineById: Map<string, MachineResolutionCandidate>;
    bestMachineIdByHost: Map<string, string>;
    bestScoreByHost: Map<string, number>;
    activeCount: number;
    onlyActiveMachineId: string | null;
    onlyMachineId: string | null;
};

function createMutableMachineResolutionContextState(): MutableMachineResolutionContextState {
    return {
        machineIds: new Set<string>(),
        machineById: new Map<string, MachineResolutionCandidate>(),
        bestMachineIdByHost: new Map<string, string>(),
        bestScoreByHost: new Map<string, number>(),
        activeCount: 0,
        onlyActiveMachineId: null,
        onlyMachineId: null,
    };
}

function addMachineToResolutionContextState(
    state: MutableMachineResolutionContextState,
    machine: MachineResolutionCandidate,
): void {
    const machineId = normalizeNonEmptyString(machine.id);
    if (!machineId) {
        return;
    }
    state.machineIds.add(machineId);
    state.machineById.set(machineId, machine);
    if (state.onlyMachineId === null) {
        state.onlyMachineId = machineId;
    } else {
        state.onlyMachineId = '';
    }

    if (machine.active === true) {
        state.activeCount += 1;
        if (state.onlyActiveMachineId === null) {
            state.onlyActiveMachineId = machineId;
        } else {
            state.onlyActiveMachineId = '';
        }
    }

    const machineHost = normalizeNonEmptyString(machine.metadata?.host);
    if (!machineHost) {
        return;
    }
    const score = (machine.active === true ? 1_000_000_000_000 : 0) + (machine.activeAt ?? 0);
    const bestScore = state.bestScoreByHost.get(machineHost) ?? Number.NEGATIVE_INFINITY;
    if (score <= bestScore) {
        return;
    }
    state.bestScoreByHost.set(machineHost, score);
    state.bestMachineIdByHost.set(machineHost, machineId);
}

function finalizeMachineResolutionContextState(
    state: MutableMachineResolutionContextState,
): MachineResolutionContext {
    const fallbackMachineId =
        state.activeCount === 1
            ? state.onlyActiveMachineId && state.onlyActiveMachineId.length > 0
                ? state.onlyActiveMachineId
                : null
            : state.activeCount === 0 && state.onlyMachineId && state.onlyMachineId.length > 0
                ? state.onlyMachineId
                : null;

    return {
        machineIds: state.machineIds,
        machineById: state.machineById,
        bestMachineIdByHost: state.bestMachineIdByHost,
        fallbackMachineId,
    };
}

function buildMachineResolutionContextFromIterable(machines: Iterable<Machine>): MachineResolutionContext {
    const state = createMutableMachineResolutionContextState();
    for (const machine of machines) {
        addMachineToResolutionContextState(state, machine);
    }
    return finalizeMachineResolutionContextState(state);
}

export function buildMachineResolutionContext(machines: ReadonlyArray<Machine>): MachineResolutionContext {
    return buildMachineResolutionContextFromIterable(machines);
}

export function buildMachineResolutionContextFromRecord<TMachine extends MachineResolutionCandidate>(
    machinesById: Readonly<Record<string, TMachine>>,
): MachineResolutionContext {
    const state = createMutableMachineResolutionContextState();
    for (const machineId in machinesById) {
        addMachineToResolutionContextState(state, machinesById[machineId]);
    }
    return finalizeMachineResolutionContextState(state);
}

function resolveMachineIdByHost(hostInput: unknown, context: MachineResolutionContext): string | null {
    const host = normalizeNonEmptyString(hostInput);
    if (!host) return null;
    return context.bestMachineIdByHost.get(host) ?? null;
}

export function normalizeSessionPathForComparison(pathInput: unknown, homeDirInput: unknown): string | null {
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
    comparablePath?: string | null;
}>;

export function resolveSessionMachineRpcTarget(input: Readonly<{
    sessionId: string;
    sessionMachineId?: string | null;
    sessionHostHint?: string | null;
    sessionPath?: string | null;
    sessionHomeDir?: string | null;
    comparableBasePath?: string | null;
    projectMachineId?: string | null;
    projectPath?: string | null;
    machineResolutionContext: MachineResolutionContext;
    peerSessions?: ReadonlyArray<SessionMachineTargetPeer>;
    peerSessionsSorted?: boolean;
    peerSessionsComparablePathFiltered?: boolean;
}>): { machineId: string; basePath: string } | null {
    const basePath = normalizeNonEmptyString(input.projectPath) ?? normalizeNonEmptyString(input.sessionPath);
    if (!basePath) return null;

    const machineResolutionContext = input.machineResolutionContext;
    const knownMachineCandidate = (candidateMachineId: string | null): string | null => {
        if (!candidateMachineId) return null;
        return machineResolutionContext.machineIds.has(candidateMachineId) ? candidateMachineId : null;
    };

    const primaryResolved = resolveSessionReachableMachineIdWithContext({
        machineId: input.sessionMachineId ?? null,
        fallbackMachineId: input.projectMachineId ?? null,
        hostHint: input.sessionHostHint ?? null,
        machineResolutionContext,
    });
    const knownPrimary = knownMachineCandidate(primaryResolved);
    if (knownPrimary) {
        return { machineId: knownPrimary, basePath };
    }

    const comparableBasePath = input.comparableBasePath ?? normalizeSessionPathForComparison(basePath, input.sessionHomeDir);
    if (comparableBasePath && Array.isArray(input.peerSessions) && input.peerSessions.length > 0) {
        if (input.peerSessionsComparablePathFiltered === true && input.peerSessionsSorted === true) {
            for (const peer of input.peerSessions) {
                if (peer.id === input.sessionId) {
                    continue;
                }

                const resolved = resolveSessionReachableMachineIdWithContext({
                    machineId: peer.machineId ?? null,
                    fallbackMachineId: peer.projectMachineId ?? null,
                    hostHint: peer.hostHint ?? null,
                    machineResolutionContext,
                });
                const knownPeer = knownMachineCandidate(resolved);
                if (knownPeer) {
                    return { machineId: knownPeer, basePath };
                }
            }
        } else {
            const peers: SessionMachineTargetPeer[] = [];
            for (const peer of input.peerSessions) {
                if (peer.id === input.sessionId) {
                    continue;
                }
                if (input.peerSessionsComparablePathFiltered === true) {
                    peers.push(peer);
                    continue;
                }

                const comparablePeerPath =
                    peer.comparablePath
                    ?? normalizeSessionPathForComparison(peer.path ?? null, peer.homeDir ?? null)
                    ?? normalizeSessionPathForComparison(peer.projectPath ?? null, peer.homeDir ?? null);
                if (comparablePeerPath !== comparableBasePath) {
                    continue;
                }
                peers.push(peer);
            }
            if (input.peerSessionsSorted !== true) {
                peers.sort((a, b) => {
                    const activeDelta = Number(Boolean(b.active)) - Number(Boolean(a.active));
                    if (activeDelta !== 0) return activeDelta;
                    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
                });
            }

            for (const peer of peers) {
                const resolved = resolveSessionReachableMachineIdWithContext({
                    machineId: peer.machineId ?? null,
                    fallbackMachineId: peer.projectMachineId ?? null,
                    hostHint: peer.hostHint ?? null,
                    machineResolutionContext,
                });
                const knownPeer = knownMachineCandidate(resolved);
                if (knownPeer) {
                    return { machineId: knownPeer, basePath };
                }
            }
        }
    }

    const fallbackMachineId = machineResolutionContext.fallbackMachineId;
    if (fallbackMachineId) {
        return { machineId: fallbackMachineId, basePath };
    }

    if (primaryResolved) {
        return { machineId: primaryResolved, basePath };
    }

    return null;
}

function resolveSessionReachableMachineIdWithContext(input: Readonly<{
    machineId: string | null | undefined;
    fallbackMachineId?: string | null | undefined;
    hostHint?: string | null | undefined;
    machineResolutionContext: MachineResolutionContext;
}>): string | null {
    const machineId = normalizeNonEmptyString(input.machineId);
    const fallbackMachineId = normalizeNonEmptyString(input.fallbackMachineId);
    const hostHint = normalizeNonEmptyString(input.hostHint);

    if (machineId && !machineId.startsWith('host:')) {
        const directMachine = input.machineResolutionContext.machineById.get(machineId);
        if (directMachine?.active) return machineId;

        const hostCandidate = resolveMachineIdByHost(
            normalizeNonEmptyString(directMachine?.metadata?.host) ?? hostHint,
            input.machineResolutionContext,
        );
        if (hostCandidate) return hostCandidate;
        if (fallbackMachineId && fallbackMachineId !== machineId) return fallbackMachineId;
        return machineId;
    }

    const hostFromMachineId = machineId?.startsWith('host:') ? machineId.slice('host:'.length) : null;
    return resolveMachineIdByHost(hostFromMachineId ?? hostHint, input.machineResolutionContext) ?? fallbackMachineId;
}

export function resolveSessionReachableMachineId(input: Readonly<{
    machineId: string | null | undefined;
    fallbackMachineId?: string | null | undefined;
    hostHint?: string | null | undefined;
    machines: ReadonlyArray<Machine>;
}>): string | null {
    return resolveSessionReachableMachineIdWithContext({
        machineId: input.machineId,
        fallbackMachineId: input.fallbackMachineId,
        hostHint: input.hostHint,
        machineResolutionContext: buildMachineResolutionContext(input.machines),
    });
}
