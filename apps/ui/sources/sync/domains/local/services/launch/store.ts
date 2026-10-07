import type {
    LocalServiceLauncherSnapshot,
    LocalServiceLauncherState,
    LocalServiceLaunchTarget,
} from './types';

const selectedTargets = new WeakMap<LocalServiceLauncherState['targetsById'], readonly LocalServiceLaunchTarget[]>();

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

    return {
        ...state,
        machineId: input.machineId,
        sessionId: input.sessionId ?? state.sessionId,
        refreshStatus: 'refreshing',
        refreshError: null,
    };
}

export function applyLocalServiceLauncherSnapshot(
    state: LocalServiceLauncherState,
    snapshot: LocalServiceLauncherSnapshot,
): LocalServiceLauncherState {
    const targetsById = new Map<string, LocalServiceLaunchTarget>();
    const targetIds: string[] = [];

    for (const target of snapshot.targets) {
        targetIds.push(target.id);
        const previous = state.targetsById.get(target.id);
        targetsById.set(target.id, areTargetsEquivalent(previous, target)
            ? previous as LocalServiceLaunchTarget
            : target);
    }

    const sameIds = state.targetIds.length === targetIds.length && targetIds.every((id, index) => id === state.targetIds[index]);
    const sameTargets = sameIds && targetIds.every(id => targetsById.get(id) === state.targetsById.get(id));
    if (state.machineId === snapshot.machineId && state.sessionId === (snapshot.sessionId ?? null)
        && state.updatedAt === snapshot.updatedAt && state.refreshStatus === 'idle' && state.refreshError === null && sameTargets) return state;

    return {
        machineId: snapshot.machineId,
        sessionId: snapshot.sessionId ?? null,
        updatedAt: snapshot.updatedAt,
        refreshStatus: 'idle',
        refreshError: null,
        targetIds: sameIds ? state.targetIds : targetIds,
        targetsById: sameTargets ? state.targetsById : targetsById,
    };
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

    return {
        ...state,
        machineId: input.machineId,
        sessionId: input.sessionId ?? state.sessionId,
        refreshStatus: 'error',
        refreshError: input.reasonCode,
    };
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
        updatedAt: state.updatedAt,
        targets: [...selectLocalServiceLaunchTargets(state)],
    };
}
