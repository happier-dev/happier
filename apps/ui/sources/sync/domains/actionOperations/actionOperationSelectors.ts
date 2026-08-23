import {
    isActionOperationTerminal,
    type ActionOperationObservation,
    type ActionOperationStoreSnapshot,
} from './actionOperationStore';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

export type ActionOperationProjection = Readonly<{
    snapshot: ActionOperationSnapshotV1;
    observation: ActionOperationObservation;
    isUnavailableProjection: boolean;
    followUpAttention?: string | null;
}>;

export type ActionOperationSelectors = Readonly<{
    selectAll(state: ActionOperationStoreSnapshot): readonly ActionOperationProjection[];
    selectById(state: ActionOperationStoreSnapshot, operationId: string): ActionOperationProjection | null;
    selectActive(state: ActionOperationStoreSnapshot): readonly ActionOperationProjection[];
    selectForSession(state: ActionOperationStoreSnapshot, sessionId: string): readonly ActionOperationProjection[];
    selectHasUnseenTerminal(state: ActionOperationStoreSnapshot): boolean;
    selectHasAttention(state: ActionOperationStoreSnapshot): boolean;
}>;

const EMPTY_OPERATIONS: readonly ActionOperationProjection[] = Object.freeze([]);

function hasSameItems<T>(current: readonly T[], next: readonly T[]): boolean {
    return current.length === next.length && current.every((item, index) => item === next[index]);
}

function compareOperations(a: ActionOperationProjection, b: ActionOperationProjection): number {
    const aActive = !isActionOperationTerminal(a.snapshot.state);
    const bActive = !isActionOperationTerminal(b.snapshot.state);
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive) return b.snapshot.createdAt - a.snapshot.createdAt;
    return (b.snapshot.settledAt ?? b.snapshot.createdAt) - (a.snapshot.settledAt ?? a.snapshot.createdAt);
}

function isUnseen(state: ActionOperationStoreSnapshot, operation: ActionOperationProjection): boolean {
    if (!isActionOperationTerminal(operation.snapshot.state)) return false;
    const seen = state.seenAtByOperationId.get(operation.snapshot.operationId);
    return seen === undefined || operation.snapshot.revision > seen.revision;
}

export function createActionOperationSelectors(): ActionOperationSelectors {
    let previousState: ActionOperationStoreSnapshot | null = null;
    let previousAll: readonly ActionOperationProjection[] = EMPTY_OPERATIONS;
    let previousActive: readonly ActionOperationProjection[] = EMPTY_OPERATIONS;
    const projectionCache = new Map<string, ActionOperationProjection>();
    const sessionCache = new Map<string, readonly ActionOperationProjection[]>();

    const selectAll = (state: ActionOperationStoreSnapshot): readonly ActionOperationProjection[] => {
        if (state === previousState) return previousAll;
        const retainedIds = new Set<string>();
        const next = Array.from(state.operationsById.values())
        .filter((snapshot) => !(
            (snapshot.state === 'succeeded'
                && state.dismissedRecentOperationIds.has(snapshot.operationId))
            || (
                state.unavailableOperationIds.has(snapshot.operationId)
                && state.dismissedUnavailableOperationIds.has(snapshot.operationId)
            )
        ))
        .map((snapshot) => {
            retainedIds.add(snapshot.operationId);
            const isUnavailableProjection = state.unavailableOperationIds.has(snapshot.operationId);
            const observation = isUnavailableProjection
                ? 'unavailable'
                : state.machineObservationById.get(snapshot.scope.machineId) ?? 'unavailable';
            const followUpAttention = snapshot.requestId
                ? state.followUpAttentionByRequestId.get(snapshot.requestId) ?? null
                : null;
            const cached = projectionCache.get(snapshot.operationId);
            if (
                cached?.snapshot === snapshot
                && cached.observation === observation
                && cached.isUnavailableProjection === isUnavailableProjection
                && cached.followUpAttention === followUpAttention
            ) return cached;
            const projection = Object.freeze({ snapshot, observation, isUnavailableProjection, followUpAttention });
            projectionCache.set(snapshot.operationId, projection);
            return projection;
        }).sort(compareOperations);
        for (const operationId of projectionCache.keys()) {
            if (!retainedIds.has(operationId)) projectionCache.delete(operationId);
        }
        const nextAll = next.length === 0
            ? EMPTY_OPERATIONS
            : hasSameItems(previousAll, next) ? previousAll : Object.freeze(next);
        const active = nextAll.filter((operation) => !isActionOperationTerminal(operation.snapshot.state));
        previousState = state;
        previousAll = nextAll;
        previousActive = active.length === 0
            ? EMPTY_OPERATIONS
            : hasSameItems(previousActive, active) ? previousActive : Object.freeze(active);
        return previousAll;
    };

    const selectById = (state: ActionOperationStoreSnapshot, operationId: string) => {
        selectAll(state);
        return projectionCache.get(operationId) ?? null;
    };

    const selectActive = (state: ActionOperationStoreSnapshot) => {
        selectAll(state);
        return previousActive;
    };

    const selectForSession = (state: ActionOperationStoreSnapshot, sessionId: string) => {
        const operations = selectAll(state).filter((operation) => operation.snapshot.scope.sessionId === sessionId);
        const cached = sessionCache.get(sessionId) ?? EMPTY_OPERATIONS;
        const stable = operations.length === 0
            ? EMPTY_OPERATIONS
            : hasSameItems(cached, operations) ? cached : Object.freeze(operations);
        sessionCache.set(sessionId, stable);
        return stable;
    };

    const selectHasUnseenTerminal = (state: ActionOperationStoreSnapshot) => selectAll(state).some((operation) => isUnseen(state, operation));
    const selectHasAttention = (state: ActionOperationStoreSnapshot) => (
        selectActive(state).length > 0
        || selectHasUnseenTerminal(state)
        || selectAll(state).some((operation) => operation.followUpAttention !== null)
    );

    return {
        selectAll,
        selectById,
        selectActive,
        selectForSession,
        selectHasUnseenTerminal,
        selectHasAttention,
    };
}

export const actionOperationSelectors = createActionOperationSelectors();
