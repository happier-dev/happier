import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

export type ActionOperationScope = Readonly<{
    accountId: string;
    machineId: string;
}>;

export type ActionOperationObservation = 'available' | 'reconnecting' | 'status_unavailable';

export type ActionOperationStoreState = Readonly<{
    operationsById: ReadonlyMap<string, ActionOperationSnapshotV1>;
    observationByScope: ReadonlyMap<string, ActionOperationObservation>;
    terminalSeenAtById: ReadonlyMap<string, number>;
    dismissedOperationIds: ReadonlySet<string>;
}>;

export type ActionOperationStore = Readonly<{
    getState: () => ActionOperationStoreState;
    subscribe: (listener: () => void) => () => void;
    merge: (snapshot: ActionOperationSnapshotV1) => boolean;
    mergeFullSnapshot: (snapshot: ActionOperationSnapshotV1) => boolean;
    reconcileMachineList: (
        scope: ActionOperationScope,
        listedOperationIds: ReadonlySet<string>,
    ) => Readonly<{ missingActive: boolean }>;
    markSeen: (operationId: string, seenAt?: number) => boolean;
    markAllTerminalSeen: (seenAt?: number) => boolean;
    dismissRecent: (
        accountId: string,
        options?: Readonly<{ preserveOperationIds?: ReadonlySet<string> }>,
    ) => boolean;
    dismissUnavailable: (operationId: string) => boolean;
    setObservation: (scope: ActionOperationScope, observation: ActionOperationObservation) => void;
}>;

const terminalStates = new Set<ActionOperationSnapshotV1['state']>(['succeeded', 'failed', 'cancelled']);
const recentStates = new Set<ActionOperationSnapshotV1['state']>(['succeeded', 'cancelled']);

export function actionOperationScopeKey(scope: ActionOperationScope): string {
    return JSON.stringify([scope.accountId, scope.machineId]);
}

function lifecycleRank(state: ActionOperationSnapshotV1['state']): number {
    if (state === 'accepted') return 0;
    if (state === 'running') return 1;
    return 2;
}

export function createActionOperationStore(): ActionOperationStore {
    let state: ActionOperationStoreState = {
        operationsById: new Map(),
        observationByScope: new Map(),
        terminalSeenAtById: new Map(),
        dismissedOperationIds: new Set(),
    };
    const listeners = new Set<() => void>();

    const publish = (next: ActionOperationStoreState): void => {
        state = next;
        for (const listener of listeners) listener();
    };

    const merge = (incoming: ActionOperationSnapshotV1): boolean => {
        const existing = state.operationsById.get(incoming.operationId);
        if (existing) {
            if (incoming.revision <= existing.revision) return false;
            if (terminalStates.has(existing.state)) return false;
            if (lifecycleRank(incoming.state) < lifecycleRank(existing.state)) return false;
        }

        const operationsById = new Map(state.operationsById);
        operationsById.set(incoming.operationId, incoming);
        const scopeKey = actionOperationScopeKey(incoming.scope);
        const observationByScope = state.observationByScope.get(scopeKey) === 'available'
            ? state.observationByScope
            : new Map([...state.observationByScope, [scopeKey, 'available' as const]]);
        publish({ ...state, operationsById, observationByScope });
        return true;
    };

    return {
        getState: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        merge,
        mergeFullSnapshot: (incoming) => {
            const existing = state.operationsById.get(incoming.operationId);
            if (!existing || incoming.revision > existing.revision) return merge(incoming);
            if (
                incoming === existing
                || incoming.revision !== existing.revision
                || incoming.state !== existing.state
            ) {
                return false;
            }

            const operationsById = new Map(state.operationsById);
            operationsById.set(incoming.operationId, incoming);
            publish({ ...state, operationsById });
            return true;
        },
        reconcileMachineList: (scope, listedOperationIds) => {
            let operationsById: Map<string, ActionOperationSnapshotV1> | null = null;
            let terminalSeenAtById: Map<string, number> | null = null;
            let dismissedOperationIds: Set<string> | null = null;
            let missingActive = false;

            for (const operation of state.operationsById.values()) {
                if (
                    operation.scope.accountId !== scope.accountId
                    || operation.scope.machineId !== scope.machineId
                    || listedOperationIds.has(operation.operationId)
                ) {
                    continue;
                }
                if (!terminalStates.has(operation.state)) {
                    missingActive = true;
                    continue;
                }
                operationsById ??= new Map(state.operationsById);
                operationsById.delete(operation.operationId);
                if (state.terminalSeenAtById.has(operation.operationId)) {
                    terminalSeenAtById ??= new Map(state.terminalSeenAtById);
                    terminalSeenAtById.delete(operation.operationId);
                }
                if (state.dismissedOperationIds.has(operation.operationId)) {
                    dismissedOperationIds ??= new Set(state.dismissedOperationIds);
                    dismissedOperationIds.delete(operation.operationId);
                }
            }

            const scopeKey = actionOperationScopeKey(scope);
            const nextObservation: ActionOperationObservation = missingActive ? 'status_unavailable' : 'available';
            let observationByScope = state.observationByScope;
            if (observationByScope.get(scopeKey) !== nextObservation) {
                const nextObservationByScope = new Map(observationByScope);
                nextObservationByScope.set(scopeKey, nextObservation);
                observationByScope = nextObservationByScope;
            }
            if (
                operationsById
                || terminalSeenAtById
                || dismissedOperationIds
                || observationByScope !== state.observationByScope
            ) {
                publish({
                    operationsById: operationsById ?? state.operationsById,
                    observationByScope,
                    terminalSeenAtById: terminalSeenAtById ?? state.terminalSeenAtById,
                    dismissedOperationIds: dismissedOperationIds ?? state.dismissedOperationIds,
                });
            }
            return { missingActive };
        },
        markSeen: (operationId, seenAt = Date.now()) => {
            const operation = state.operationsById.get(operationId);
            if (!operation || !terminalStates.has(operation.state)) return false;
            if (state.terminalSeenAtById.has(operationId)) return false;
            const terminalSeenAtById = new Map(state.terminalSeenAtById);
            terminalSeenAtById.set(operationId, seenAt);
            publish({ ...state, terminalSeenAtById });
            return true;
        },
        markAllTerminalSeen: (seenAt = Date.now()) => {
            let terminalSeenAtById: Map<string, number> | null = null;
            for (const operation of state.operationsById.values()) {
                if (!terminalStates.has(operation.state) || state.terminalSeenAtById.has(operation.operationId)) continue;
                terminalSeenAtById ??= new Map(state.terminalSeenAtById);
                terminalSeenAtById.set(operation.operationId, seenAt);
            }
            if (!terminalSeenAtById) return false;
            publish({ ...state, terminalSeenAtById });
            return true;
        },
        dismissRecent: (accountId, options) => {
            let dismissedOperationIds: Set<string> | null = null;
            for (const operation of state.operationsById.values()) {
                if (
                    operation.scope.accountId !== accountId
                    || !recentStates.has(operation.state)
                    || options?.preserveOperationIds?.has(operation.operationId) === true
                    || state.dismissedOperationIds.has(operation.operationId)
                ) {
                    continue;
                }
                dismissedOperationIds ??= new Set(state.dismissedOperationIds);
                dismissedOperationIds.add(operation.operationId);
            }
            if (!dismissedOperationIds) return false;
            publish({ ...state, dismissedOperationIds });
            return true;
        },
        dismissUnavailable: (operationId) => {
            const operation = state.operationsById.get(operationId);
            if (!operation || terminalStates.has(operation.state) || state.dismissedOperationIds.has(operationId)) {
                return false;
            }
            if (state.observationByScope.get(actionOperationScopeKey(operation.scope)) !== 'status_unavailable') {
                return false;
            }
            const dismissedOperationIds = new Set(state.dismissedOperationIds);
            dismissedOperationIds.add(operationId);
            publish({ ...state, dismissedOperationIds });
            return true;
        },
        setObservation: (scope, observation) => {
            const scopeKey = actionOperationScopeKey(scope);
            if (state.observationByScope.get(scopeKey) === observation) return;
            const observationByScope = new Map(state.observationByScope);
            observationByScope.set(scopeKey, observation);
            publish({ ...state, observationByScope });
        },
    };
}

export const actionOperationStore = createActionOperationStore();
