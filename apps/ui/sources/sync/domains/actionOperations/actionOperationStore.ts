import type { ActionOperationSnapshotV1, ActionOperationStateV1 } from '@happier-dev/protocol';

export type ActionOperationObservation = 'available' | 'reconnecting' | 'unavailable';

export type ActionOperationStoreSnapshot = Readonly<{
    operationsById: ReadonlyMap<string, ActionOperationSnapshotV1>;
    machineObservationById: ReadonlyMap<string, ActionOperationObservation>;
    unavailableOperationIds: ReadonlySet<string>;
    seenAtByOperationId: ReadonlyMap<string, Readonly<{ seenAt: number; revision: number }>>;
    dismissedRecentOperationIds: ReadonlySet<string>;
    dismissedUnavailableOperationIds: ReadonlySet<string>;
    followUpAttentionByRequestId: ReadonlyMap<string, string>;
}>;

export type ActionOperationStore = Readonly<{
    getSnapshot(): ActionOperationStoreSnapshot;
    subscribe(listener: () => void): () => void;
    mergeSnapshots(snapshots: readonly ActionOperationSnapshotV1[]): void;
    reconcileMachineProjection(input: Readonly<{
        accountId: string;
        machineId: string;
        snapshots: readonly ActionOperationSnapshotV1[];
        knownOperationIds: ReadonlySet<string>;
    }>): void;
    retainAccountMachines(accountId: string, machineIds: ReadonlySet<string>): void;
    setMachineObservation(machineId: string, observation: ActionOperationObservation): void;
    markTerminalSeen(operationId: string, seenAt?: number): boolean;
    markAllTerminalSeen(seenAt?: number): boolean;
    dismissRecentSucceeded(): boolean;
    dismissUnavailable(operationId: string): boolean;
    markFollowUpNeedsAttention(requestId: string, message: string): void;
    reset(): void;
}>;

const EMPTY_STATE: ActionOperationStoreSnapshot = Object.freeze({
    operationsById: new Map(),
    machineObservationById: new Map(),
    unavailableOperationIds: new Set<string>(),
    seenAtByOperationId: new Map(),
    dismissedRecentOperationIds: new Set<string>(),
    dismissedUnavailableOperationIds: new Set<string>(),
    followUpAttentionByRequestId: new Map<string, string>(),
});

const TERMINAL_STATES: ReadonlySet<ActionOperationStateV1> = new Set([
    'succeeded',
    'failed',
    'cancelled',
]);

function canMergeSnapshot(
    current: ActionOperationSnapshotV1 | undefined,
    incoming: ActionOperationSnapshotV1,
): boolean {
    if (!current) return true;
    if (incoming.revision <= current.revision) return false;
    if (TERMINAL_STATES.has(current.state)) return false;
    if (current.state === 'running' && incoming.state === 'accepted') return false;
    return true;
}

export function createActionOperationStore(): ActionOperationStore {
    let state = EMPTY_STATE;
    const listeners = new Set<() => void>();

    const publish = (next: ActionOperationStoreSnapshot) => {
        state = next;
        for (const listener of listeners) listener();
    };

    return {
        getSnapshot() {
            return state;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        mergeSnapshots(snapshots) {
            let operationsById: Map<string, ActionOperationSnapshotV1> | null = null;
            let machineObservationById: Map<string, ActionOperationObservation> | null = null;
            let unavailableOperationIds: Set<string> | null = null;
            let dismissedUnavailableOperationIds: Set<string> | null = null;

            for (const incoming of snapshots) {
                const currentOperations = operationsById ?? state.operationsById;
                if (state.unavailableOperationIds.has(incoming.operationId)) {
                    unavailableOperationIds ??= new Set(state.unavailableOperationIds);
                    unavailableOperationIds.delete(incoming.operationId);
                }
                if (state.dismissedUnavailableOperationIds.has(incoming.operationId)) {
                    dismissedUnavailableOperationIds ??= new Set(state.dismissedUnavailableOperationIds);
                    dismissedUnavailableOperationIds.delete(incoming.operationId);
                }
                if (!canMergeSnapshot(currentOperations.get(incoming.operationId), incoming)) continue;
                operationsById ??= new Map(state.operationsById);
                operationsById.set(incoming.operationId, incoming);

                const currentObservations = machineObservationById ?? state.machineObservationById;
                if (currentObservations.get(incoming.scope.machineId) !== 'available') {
                    machineObservationById ??= new Map(state.machineObservationById);
                    machineObservationById.set(incoming.scope.machineId, 'available');
                }
            }

            if (!operationsById && !machineObservationById && !unavailableOperationIds && !dismissedUnavailableOperationIds) return;
            publish(Object.freeze({
                operationsById: operationsById ?? state.operationsById,
                machineObservationById: machineObservationById ?? state.machineObservationById,
                unavailableOperationIds: unavailableOperationIds ?? state.unavailableOperationIds,
                seenAtByOperationId: state.seenAtByOperationId,
                dismissedRecentOperationIds: state.dismissedRecentOperationIds,
                dismissedUnavailableOperationIds: dismissedUnavailableOperationIds ?? state.dismissedUnavailableOperationIds,
                followUpAttentionByRequestId: state.followUpAttentionByRequestId,
            }));
        },
        reconcileMachineProjection(input) {
            const listedOperationIds = new Set(input.snapshots.map((snapshot) => snapshot.operationId));
            let operationsById: Map<string, ActionOperationSnapshotV1> | null = null;
            let machineObservationById: Map<string, ActionOperationObservation> | null = null;
            let seenAtByOperationId: Map<string, Readonly<{ seenAt: number; revision: number }>> | null = null;
            let unavailableOperationIds: Set<string> | null = null;
            let dismissedUnavailableOperationIds: Set<string> | null = null;

            for (const [operationId, snapshot] of state.operationsById) {
                if (snapshot.scope.accountId !== input.accountId || snapshot.scope.machineId !== input.machineId) continue;
                if (listedOperationIds.has(operationId)) {
                    if (state.unavailableOperationIds.has(operationId)) {
                        unavailableOperationIds ??= new Set(state.unavailableOperationIds);
                        unavailableOperationIds.delete(operationId);
                    }
                    if (state.dismissedUnavailableOperationIds.has(operationId)) {
                        dismissedUnavailableOperationIds ??= new Set(state.dismissedUnavailableOperationIds);
                        dismissedUnavailableOperationIds.delete(operationId);
                    }
                    continue;
                }
                if (!input.knownOperationIds.has(operationId)) continue;
                if (!TERMINAL_STATES.has(snapshot.state)) {
                    if (!state.unavailableOperationIds.has(operationId)) {
                        unavailableOperationIds ??= new Set(state.unavailableOperationIds);
                        unavailableOperationIds.add(operationId);
                    }
                    continue;
                }
                operationsById ??= new Map(state.operationsById);
                operationsById.delete(operationId);
                if (state.seenAtByOperationId.has(operationId)) {
                    seenAtByOperationId ??= new Map(state.seenAtByOperationId);
                    seenAtByOperationId.delete(operationId);
                }
                if (state.dismissedUnavailableOperationIds.has(operationId)) {
                    dismissedUnavailableOperationIds ??= new Set(state.dismissedUnavailableOperationIds);
                    dismissedUnavailableOperationIds.delete(operationId);
                }
                if (state.unavailableOperationIds.has(operationId)) {
                    unavailableOperationIds ??= new Set(state.unavailableOperationIds);
                    unavailableOperationIds.delete(operationId);
                }
            }

            for (const incoming of input.snapshots) {
                if (incoming.scope.accountId !== input.accountId || incoming.scope.machineId !== input.machineId) continue;
                const currentOperations = operationsById ?? state.operationsById;
                if (!canMergeSnapshot(currentOperations.get(incoming.operationId), incoming)) continue;
                operationsById ??= new Map(state.operationsById);
                operationsById.set(incoming.operationId, incoming);
            }

            const observation: ActionOperationObservation = 'available';
            if (state.machineObservationById.get(input.machineId) !== observation) {
                machineObservationById = new Map(state.machineObservationById);
                machineObservationById.set(input.machineId, observation);
            }

            if (!operationsById && !machineObservationById && !seenAtByOperationId && !unavailableOperationIds && !dismissedUnavailableOperationIds) return;
            publish(Object.freeze({
                operationsById: operationsById ?? state.operationsById,
                machineObservationById: machineObservationById ?? state.machineObservationById,
                unavailableOperationIds: unavailableOperationIds ?? state.unavailableOperationIds,
                seenAtByOperationId: seenAtByOperationId ?? state.seenAtByOperationId,
                dismissedRecentOperationIds: state.dismissedRecentOperationIds,
                dismissedUnavailableOperationIds: dismissedUnavailableOperationIds ?? state.dismissedUnavailableOperationIds,
                followUpAttentionByRequestId: state.followUpAttentionByRequestId,
            }));
        },
        retainAccountMachines(accountId, machineIds) {
            let operationsById: Map<string, ActionOperationSnapshotV1> | null = null;
            let machineObservationById: Map<string, ActionOperationObservation> | null = null;
            let seenAtByOperationId: Map<string, Readonly<{ seenAt: number; revision: number }>> | null = null;
            let unavailableOperationIds: Set<string> | null = null;
            let dismissedUnavailableOperationIds: Set<string> | null = null;

            for (const [operationId, snapshot] of state.operationsById) {
                if (snapshot.scope.accountId !== accountId || machineIds.has(snapshot.scope.machineId)) continue;
                operationsById ??= new Map(state.operationsById);
                operationsById.delete(operationId);
                if (state.seenAtByOperationId.has(operationId)) {
                    seenAtByOperationId ??= new Map(state.seenAtByOperationId);
                    seenAtByOperationId.delete(operationId);
                }
                if (state.dismissedUnavailableOperationIds.has(operationId)) {
                    dismissedUnavailableOperationIds ??= new Set(state.dismissedUnavailableOperationIds);
                    dismissedUnavailableOperationIds.delete(operationId);
                }
                if (state.unavailableOperationIds.has(operationId)) {
                    unavailableOperationIds ??= new Set(state.unavailableOperationIds);
                    unavailableOperationIds.delete(operationId);
                }
            }
            for (const machineId of state.machineObservationById.keys()) {
                if (machineIds.has(machineId)) continue;
                machineObservationById ??= new Map(state.machineObservationById);
                machineObservationById.delete(machineId);
            }

            if (!operationsById && !machineObservationById && !seenAtByOperationId && !unavailableOperationIds && !dismissedUnavailableOperationIds) return;
            publish(Object.freeze({
                operationsById: operationsById ?? state.operationsById,
                machineObservationById: machineObservationById ?? state.machineObservationById,
                unavailableOperationIds: unavailableOperationIds ?? state.unavailableOperationIds,
                seenAtByOperationId: seenAtByOperationId ?? state.seenAtByOperationId,
                dismissedRecentOperationIds: state.dismissedRecentOperationIds,
                dismissedUnavailableOperationIds: dismissedUnavailableOperationIds ?? state.dismissedUnavailableOperationIds,
                followUpAttentionByRequestId: state.followUpAttentionByRequestId,
            }));
        },
        setMachineObservation(machineId, observation) {
            if (state.machineObservationById.get(machineId) === observation) return;
            const machineObservationById = new Map(state.machineObservationById);
            machineObservationById.set(machineId, observation);
            publish(Object.freeze({ ...state, machineObservationById }));
        },
        markTerminalSeen(operationId, seenAt = Date.now()) {
            const operation = state.operationsById.get(operationId);
            if (!operation || !TERMINAL_STATES.has(operation.state)) return false;
            const current = state.seenAtByOperationId.get(operationId);
            if (current && current.revision >= operation.revision) return false;
            const seenAtByOperationId = new Map(state.seenAtByOperationId);
            seenAtByOperationId.set(operationId, { seenAt, revision: operation.revision });
            publish(Object.freeze({ ...state, seenAtByOperationId }));
            return true;
        },
        markAllTerminalSeen(seenAt = Date.now()) {
            const seenAtByOperationId = new Map(state.seenAtByOperationId);
            let changed = false;
            for (const [operationId, operation] of state.operationsById) {
                if (!TERMINAL_STATES.has(operation.state)) continue;
                const current = seenAtByOperationId.get(operationId);
                if (current && current.seenAt >= seenAt && current.revision >= operation.revision) continue;
                seenAtByOperationId.set(operationId, { seenAt, revision: operation.revision });
                changed = true;
            }
            if (!changed) return false;
            publish(Object.freeze({ ...state, seenAtByOperationId }));
            return true;
        },
        dismissRecentSucceeded() {
            const dismissedRecentOperationIds = new Set(state.dismissedRecentOperationIds);
            let changed = false;
            for (const [operationId, operation] of state.operationsById) {
                if (operation.state !== 'succeeded' || dismissedRecentOperationIds.has(operationId)) continue;
                dismissedRecentOperationIds.add(operationId);
                changed = true;
            }
            if (!changed) return false;
            publish(Object.freeze({ ...state, dismissedRecentOperationIds }));
            return true;
        },
        dismissUnavailable(operationId) {
            const operation = state.operationsById.get(operationId);
            if (
                !operation
                || TERMINAL_STATES.has(operation.state)
                || !state.unavailableOperationIds.has(operationId)
                || state.dismissedUnavailableOperationIds.has(operationId)
            ) {
                return false;
            }
            const dismissedUnavailableOperationIds = new Set(state.dismissedUnavailableOperationIds);
            dismissedUnavailableOperationIds.add(operationId);
            publish(Object.freeze({ ...state, dismissedUnavailableOperationIds }));
            return true;
        },
        markFollowUpNeedsAttention(requestId, message) {
            const normalizedRequestId = requestId.trim();
            const normalizedMessage = message.trim();
            if (!normalizedRequestId || !normalizedMessage) return;
            if (state.followUpAttentionByRequestId.get(normalizedRequestId) === normalizedMessage) return;
            const followUpAttentionByRequestId = new Map(state.followUpAttentionByRequestId);
            followUpAttentionByRequestId.set(normalizedRequestId, normalizedMessage);
            publish(Object.freeze({ ...state, followUpAttentionByRequestId }));
        },
        reset() {
            if (state === EMPTY_STATE) return;
            publish(EMPTY_STATE);
        },
    };
}

export const actionOperationStore = createActionOperationStore();

export function isActionOperationTerminal(state: ActionOperationStateV1): boolean {
    return TERMINAL_STATES.has(state);
}
