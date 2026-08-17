import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export type MachineResolutionContext = Readonly<{
    machineIds: ReadonlySet<string>;
    machineById: ReadonlyMap<string, MachineResolutionCandidate>;
}>;

type MachineResolutionCandidate = Readonly<{
    id?: string | null;
    active?: boolean;
    activeAt?: number | null;
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
    metadata?: Readonly<{
        host?: string | null;
    }> | null;
}>;

type MutableMachineResolutionContextState = {
    machineIds: Set<string>;
    machineById: Map<string, MachineResolutionCandidate>;
};

function createMutableMachineResolutionContextState(): MutableMachineResolutionContextState {
    return {
        machineIds: new Set<string>(),
        machineById: new Map<string, MachineResolutionCandidate>(),
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
}

function finalizeMachineResolutionContextState(
    state: MutableMachineResolutionContextState,
): MachineResolutionContext {
    return {
        machineIds: state.machineIds,
        machineById: state.machineById,
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

export function normalizeSessionPathForComparison(pathInput: unknown, homeDirInput: unknown): string | null {
    const path = normalizeNonEmptyString(pathInput);
    if (!path) return null;

    const homeDir = normalizeNonEmptyString(homeDirInput);
    const expanded = resolveAbsolutePath(path, homeDir ?? undefined);

    const normalized = expanded.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (/^[a-zA-Z]:\/$/.test(normalized)) return normalized;
    if (normalized.length > 1 && normalized.endsWith('/')) return normalized.slice(0, -1);
    return normalized;
}

export type SessionMachineTargetPeer = Readonly<{
    id: string;
    active?: boolean;
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

    const primaryResolved = resolveSessionReachableMachineIdWithContext({
        machineId: input.sessionMachineId ?? input.projectMachineId ?? null,
        hostHint: input.sessionHostHint ?? null,
        machineResolutionContext,
    });
    if (primaryResolved) {
        return { machineId: primaryResolved, basePath };
    }

    const peerSessions = input.peerSessions ?? [];
    if (peerSessions.length === 0) return null;

    const comparableBasePath = normalizeNonEmptyString(input.comparableBasePath);
    const candidates = input.peerSessionsSorted === true
        ? peerSessions
        : [...peerSessions].sort(compareSessionMachineTargetPeers);
    for (const peer of candidates) {
        if (peer.id === input.sessionId) continue;
        if (input.peerSessionsComparablePathFiltered !== true && comparableBasePath) {
            const peerComparablePath = normalizeNonEmptyString(peer.comparablePath)
                ?? normalizeSessionPathForComparison(peer.projectPath ?? peer.path, peer.homeDir);
            if (peerComparablePath !== comparableBasePath) continue;
        }
        const peerMachineId = normalizeNonEmptyString(peer.projectMachineId);
        const peerResolved = resolveSessionReachableMachineIdWithContext({
            machineId: peerMachineId,
            hostHint: peer.hostHint ?? null,
            machineResolutionContext,
        });
        if (peerResolved) {
            return { machineId: peerResolved, basePath };
        }
    }
    return null;
}

function compareSessionMachineTargetPeers(
    left: SessionMachineTargetPeer,
    right: SessionMachineTargetPeer,
): number {
    const activeDelta = Number(right.active === true) - Number(left.active === true);
    if (activeDelta !== 0) return activeDelta;
    return left.id.localeCompare(right.id);
}

function resolveSessionReachableMachineIdWithContext(input: Readonly<{
    machineId: string | null | undefined;
    hostHint?: string | null | undefined;
    machineResolutionContext: MachineResolutionContext;
}>): string | null {
    const machineId = normalizeNonEmptyString(input.machineId);
    if (!machineId || machineId.startsWith('host:')) return null;

    // The context already *is* the id index this resolution needs; flattening it back into a list
    // per session made every call rebuild the index it was handed.
    const canonical = resolveCanonicalMachineId(machineId, input.machineResolutionContext.machineById);
    const resolvedMachineId = canonical?.machineId ?? machineId;
    const machine = input.machineResolutionContext.machineById.get(resolvedMachineId);
    if (!machine || machine.active !== true) return null;
    if (machine.revokedAt && machine.revokedAt > 0) return null;
    if (machine.replacedByMachineId) return null;
    return resolvedMachineId;
}

export function resolveSessionReachableMachineId(input: Readonly<{
    machineId: string | null | undefined;
    hostHint?: string | null | undefined;
    machines: ReadonlyArray<Machine>;
}>): string | null {
    return resolveSessionReachableMachineIdWithContext({
        machineId: input.machineId,
        hostHint: input.hostHint,
        machineResolutionContext: buildMachineResolutionContext(input.machines),
    });
}
