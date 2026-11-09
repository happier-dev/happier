import type {
    LocalServiceLauncherSnapshot,
    LocalServiceLauncherState,
    LocalServiceLaunchTarget,
} from './types';

const selectedTargets = new WeakMap<LocalServiceLauncherState['targetsById'], readonly LocalServiceLaunchTarget[]>();
// Receipt order is not a presentation change. Retain only the admitted daemon timestamp,
// so a newer equal reply can reject an older differing reply without notifying rows.
const snapshotTimes = new WeakMap<LocalServiceLauncherState, number>();

export function readLocalServiceLauncherSnapshotTime(state: LocalServiceLauncherState): number | null {
    return snapshotTimes.get(state) ?? state.updatedAt;
}

function carrySnapshotTime(previous: LocalServiceLauncherState, next: LocalServiceLauncherState): LocalServiceLauncherState {
    const time = readLocalServiceLauncherSnapshotTime(previous);
    if (time !== null) snapshotTimes.set(next, time);
    return next;
}

function targetKey(target: LocalServiceLaunchTarget): string {
    return JSON.stringify(target);
}

function areTargetsEquivalent(
    previous: LocalServiceLaunchTarget | undefined,
    next: LocalServiceLaunchTarget,
): boolean {
    return Boolean(previous) && targetKey(previous as LocalServiceLaunchTarget) === targetKey(next);
}

export function createLocalServiceLauncherState(): LocalServiceLauncherState {
    return {
        machineId: null,
        sessionId: null,
        updatedAt: null,
        refreshStatus: 'idle',
        refreshError: null,
        targetIds: [],
        targetsById: new Map(),
    };
}

export function applyLocalServiceLauncherRefreshStarted(
    state: LocalServiceLauncherState,
    input: Readonly<{
        machineId: string;
        sessionId?: string;
    }>,
): LocalServiceLauncherState {
    if (state.machineId !== null && state.machineId !== input.machineId) {
        return {
            machineId: input.machineId,
            sessionId: input.sessionId ?? null,
            updatedAt: null,
            refreshStatus: 'refreshing',
            refreshError: null,
            targetIds: [],
            targetsById: new Map(),
        };
    }

    return carrySnapshotTime(state, {
        ...state,
        machineId: input.machineId,
        sessionId: input.sessionId ?? state.sessionId,
        refreshStatus: 'refreshing',
        refreshError: null,
    });
}

/** The keyed collection owner, shared by native snapshots and Project binding projection. */
export function reconcileLocalServiceLauncherTargets(
    state: Pick<LocalServiceLauncherState, 'targetIds' | 'targetsById'>,
    targets: readonly LocalServiceLaunchTarget[],
): Pick<LocalServiceLauncherState, 'targetIds' | 'targetsById'> {
    const targetsById = new Map<string, LocalServiceLaunchTarget>();
    const targetIds: string[] = [];

    for (const target of targets) {
        // Project declaration enrichment can resolve to an occurrence already in the feed.
        // The keyed target remains authoritative; its ordered identity appears only once.
        if (!targetsById.has(target.id)) targetIds.push(target.id);
        const previous = state.targetsById.get(target.id);
        targetsById.set(target.id, areTargetsEquivalent(previous, target)
            ? previous as LocalServiceLaunchTarget
            : target);
    }

    const sameIds = state.targetIds.length === targetIds.length && targetIds.every((id, index) => id === state.targetIds[index]);
    const sameTargets = sameIds && targetIds.every(id => targetsById.get(id) === state.targetsById.get(id));
    return sameTargets ? state : {
        targetIds: sameIds ? state.targetIds : targetIds,
        targetsById,
    };
}

export function applyLocalServiceLauncherSnapshot(
    state: LocalServiceLauncherState,
    snapshot: LocalServiceLauncherSnapshot,
): LocalServiceLauncherState {
    // Reads and Action responses share this owner. A delayed earlier read cannot
    // replace the native facts already published by a newer response.
    const sameScope = state.machineId === snapshot.machineId && state.sessionId === (snapshot.sessionId ?? null);
    const receivedAt = readLocalServiceLauncherSnapshotTime(state);
    if (sameScope && receivedAt !== null && snapshot.updatedAt < receivedAt) return state;
    const collection = reconcileLocalServiceLauncherTargets(state, snapshot.targets);
    if (sameScope && state.refreshStatus === 'idle' && state.refreshError === null && collection === state) {
        snapshotTimes.set(state, snapshot.updatedAt);
        return state;
    }

    const next: LocalServiceLauncherState = {
        machineId: snapshot.machineId,
        sessionId: snapshot.sessionId ?? null,
        updatedAt: snapshot.updatedAt,
        refreshStatus: 'idle',
        refreshError: null,
        targetIds: collection.targetIds,
        targetsById: collection.targetsById,
    };
    snapshotTimes.set(next, snapshot.updatedAt);
    return next;
}

export function failLocalServiceLauncherRefresh(
    state: LocalServiceLauncherState,
    input: Readonly<{
        machineId: string;
        sessionId?: string;
        reasonCode: string;
    }>,
): LocalServiceLauncherState {
    if (state.machineId !== null && state.machineId !== input.machineId) {
        return {
            machineId: input.machineId,
            sessionId: input.sessionId ?? null,
            updatedAt: null,
            refreshStatus: 'error',
            refreshError: input.reasonCode,
            targetIds: [],
            targetsById: new Map(),
        };
    }

    // A failed read observes no new Service facts. Preserve the admitted rows,
    // actions and grouping; freshness belongs to this feed's refresh status.
    const sessionId = input.sessionId ?? state.sessionId;
    if (state.machineId === input.machineId && state.sessionId === sessionId
        && state.refreshStatus === 'error' && state.refreshError === input.reasonCode) return state;
    return carrySnapshotTime(state, {
        ...state,
        machineId: input.machineId,
        sessionId,
        refreshStatus: 'error',
        refreshError: input.reasonCode,
    });
}

export function selectLocalServiceLaunchTargets(
    state: LocalServiceLauncherState,
): readonly LocalServiceLaunchTarget[] {
    const previous = selectedTargets.get(state.targetsById);
    if (previous) return previous;
    const targets = state.targetIds
        .map((id) => state.targetsById.get(id))
        .filter((target): target is LocalServiceLaunchTarget => Boolean(target));
    selectedTargets.set(state.targetsById, targets);
    return targets;
}

export function snapshotFromLocalServiceLauncherState(
    state: LocalServiceLauncherState | null | undefined,
): LocalServiceLauncherSnapshot | null {
    if (!state?.machineId || state.updatedAt === null) {
        return null;
    }
    return {
        v: 1,
        machineId: state.machineId,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        updatedAt: readLocalServiceLauncherSnapshotTime(state)!,
        targets: [...selectLocalServiceLaunchTargets(state)],
    };
}
