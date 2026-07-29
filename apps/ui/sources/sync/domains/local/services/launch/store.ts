import type {
    LocalServiceLauncherSnapshot,
    LocalServiceLauncherState,
    LocalServiceLaunchTarget,
} from './types';

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
        requestedAt: number;
    }>,
): LocalServiceLauncherState {
    if (state.machineId !== null && state.machineId !== input.machineId) {
        return {
            machineId: input.machineId,
            sessionId: input.sessionId ?? null,
            updatedAt: input.requestedAt,
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
        updatedAt: input.requestedAt,
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

    return {
        machineId: snapshot.machineId,
        sessionId: snapshot.sessionId ?? null,
        updatedAt: snapshot.updatedAt,
        refreshStatus: 'idle',
        refreshError: null,
        targetIds,
        targetsById,
    };
}

export function failLocalServiceLauncherRefresh(
    state: LocalServiceLauncherState,
    input: Readonly<{
        machineId: string;
        sessionId?: string;
        failedAt: number;
        reasonCode: string;
    }>,
): LocalServiceLauncherState {
    if (state.machineId !== null && state.machineId !== input.machineId) {
        return {
            machineId: input.machineId,
            sessionId: input.sessionId ?? null,
            updatedAt: input.failedAt,
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
        updatedAt: input.failedAt,
        refreshStatus: 'error',
        refreshError: input.reasonCode,
    };
}

export function selectLocalServiceLaunchTargets(
    state: LocalServiceLauncherState,
): readonly LocalServiceLaunchTarget[] {
    return state.targetIds
        .map((id) => state.targetsById.get(id))
        .filter((target): target is LocalServiceLaunchTarget => Boolean(target));
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
