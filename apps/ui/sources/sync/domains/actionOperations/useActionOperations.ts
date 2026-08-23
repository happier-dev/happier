import * as React from 'react';

import type { ActionOperationSnapshotV1, ActionOperationStateV1 } from '@happier-dev/protocol';

import {
    createActionOperationSelector,
    selectActionOperationObservation,
    selectActionOperationObservationForOperation,
    selectActionOperationsNeedAttention,
} from './actionOperationSelectors';
import {
    actionOperationStore,
    type ActionOperationObservation,
    type ActionOperationScope,
    type ActionOperationStoreState,
} from './actionOperationStore';

function sameReferences(
    previous: readonly ActionOperationSnapshotV1[],
    next: readonly ActionOperationSnapshotV1[],
): boolean {
    return previous.length === next.length && previous.every((item, index) => item === next[index]);
}

export function createAllActionOperationsSelector(accountId: string) {
    let previous: readonly ActionOperationSnapshotV1[] = [];
    return (state: ActionOperationStoreState): readonly ActionOperationSnapshotV1[] => {
        const next = Array.from(state.operationsById.values()).filter(
            (operation) => operation.scope.accountId === accountId
                && !state.dismissedOperationIds.has(operation.operationId),
        );
        if (sameReferences(previous, next)) return previous;
        previous = next;
        return previous;
    };
}

export function createActionOperationObservationsSelector(accountId: string) {
    let previous: ReadonlyMap<string, ActionOperationObservation> = new Map();
    return (state: ActionOperationStoreState): ReadonlyMap<string, ActionOperationObservation> => {
        const next = new Map<string, ActionOperationObservation>();
        for (const [scopeKey, observation] of state.observationByScope) {
            try {
                const parsed = JSON.parse(scopeKey) as unknown;
                if (!Array.isArray(parsed) || parsed.length !== 2) continue;
                const [scopeAccountId, machineId] = parsed;
                if (scopeAccountId === accountId && typeof machineId === 'string') {
                    next.set(machineId, observation);
                }
            } catch {
                // Ignore keys not produced by the canonical scope-key encoder.
            }
        }
        if (
            previous.size === next.size
            && Array.from(next).every(([machineId, observation]) => previous.get(machineId) === observation)
        ) {
            return previous;
        }
        previous = next;
        return previous;
    };
}

export function createUnavailableActionOperationIdsSelector(accountId: string) {
    let previous: ReadonlySet<string> = new Set();
    return (state: ActionOperationStoreState): ReadonlySet<string> => {
        const next = new Set<string>();
        for (const operationId of state.unavailableOperationIds) {
            const operation = state.operationsById.get(operationId);
            if (operation?.scope.accountId === accountId) next.add(operationId);
        }
        if (previous.size === next.size && Array.from(next).every((operationId) => previous.has(operationId))) {
            return previous;
        }
        previous = next;
        return previous;
    };
}

export function useActionOperations(scope: ActionOperationScope & Readonly<{
    sessionId?: string;
    states?: readonly ActionOperationStateV1[];
}>): readonly ActionOperationSnapshotV1[] {
    const statesKey = scope.states?.join('\u0001') ?? '';
    const selector = React.useMemo(() => createActionOperationSelector(scope), [
        scope.accountId,
        scope.machineId,
        scope.sessionId,
        statesKey,
    ]);
    return React.useSyncExternalStore(
        actionOperationStore.subscribe,
        () => selector(actionOperationStore.getState()),
        () => selector(actionOperationStore.getState()),
    );
}

export function useActionOperation(operationId: string | null): ActionOperationSnapshotV1 | null {
    return React.useSyncExternalStore(
        actionOperationStore.subscribe,
        () => operationId ? actionOperationStore.getState().operationsById.get(operationId) ?? null : null,
        () => operationId ? actionOperationStore.getState().operationsById.get(operationId) ?? null : null,
    );
}

export function useAllActionOperations(accountId: string): readonly ActionOperationSnapshotV1[] {
    const selector = React.useMemo(() => createAllActionOperationsSelector(accountId), [accountId]);
    return React.useSyncExternalStore(
        actionOperationStore.subscribe,
        () => selector(actionOperationStore.getState()),
        () => selector(actionOperationStore.getState()),
    );
}

export function useActionOperationsNeedAttention(accountId: string): boolean {
    return React.useSyncExternalStore(
        actionOperationStore.subscribe,
        () => selectActionOperationsNeedAttention(actionOperationStore.getState(), accountId),
        () => selectActionOperationsNeedAttention(actionOperationStore.getState(), accountId),
    );
}

export function useActionOperationObservations(
    accountId: string,
): ReadonlyMap<string, ActionOperationObservation> {
    const selector = React.useMemo(() => createActionOperationObservationsSelector(accountId), [accountId]);
    return React.useSyncExternalStore(
        actionOperationStore.subscribe,
        () => selector(actionOperationStore.getState()),
        () => selector(actionOperationStore.getState()),
    );
}

export function useUnavailableActionOperationIds(accountId: string): ReadonlySet<string> {
    const selector = React.useMemo(() => createUnavailableActionOperationIdsSelector(accountId), [accountId]);
    return React.useSyncExternalStore(
        actionOperationStore.subscribe,
        () => selector(actionOperationStore.getState()),
        () => selector(actionOperationStore.getState()),
    );
}

export function useActionOperationObservationForOperation(
    operation: ActionOperationSnapshotV1,
): ActionOperationObservation {
    return React.useSyncExternalStore(
        actionOperationStore.subscribe,
        () => selectActionOperationObservationForOperation(actionOperationStore.getState(), operation),
        () => selectActionOperationObservationForOperation(actionOperationStore.getState(), operation),
    );
}

export function useActionOperationObservation(scope: ActionOperationScope): ActionOperationObservation {
    return React.useSyncExternalStore(
        actionOperationStore.subscribe,
        () => selectActionOperationObservation(actionOperationStore.getState(), scope),
        () => selectActionOperationObservation(actionOperationStore.getState(), scope),
    );
}
