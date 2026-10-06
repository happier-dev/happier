import { canAdvanceActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionOperationSnapshotV1, ActionOperationStateV1 } from '@happier-dev/protocol';

import {
    actionOperationAddressKey,
    actionOperationMachineAddressKey,
    actionOperationRequestAddressKey,
    normalizeActionOperationServerId,
    qualifyActionOperationSnapshot,
    type ActionOperationAddress,
    type ActionOperationMachineAddress,
    type QualifiedActionOperation,
} from './qualifiedActionOperation';

export type ActionOperationObservation = 'available' | 'reconnecting' | 'unavailable';

export type ActionOperationStoreSnapshot = Readonly<{
    operationsByKey: ReadonlyMap<string, QualifiedActionOperation>;
    machineObservationByKey: ReadonlyMap<string, ActionOperationObservation>;
    unavailableOperationKeys: ReadonlySet<string>;
    seenAtByOperationKey: ReadonlyMap<string, Readonly<{ seenAt: number; revision: number }>>;
    dismissedRecentOperationKeys: ReadonlySet<string>;
    dismissedUnavailableOperationKeys: ReadonlySet<string>;
    followUpAttentionByRequestKey: ReadonlyMap<string, string>;
}>;

export type ActionOperationStore = Readonly<{
    getSnapshot(): ActionOperationStoreSnapshot;
    subscribe(listener: () => void): () => void;
    mergeSnapshots(input: Readonly<{ serverId: string | null; snapshots: readonly ActionOperationSnapshotV1[] }>): void;
    reconcileMachineProjection(input: Readonly<{
        serverId: string;
        accountId: string;
        machineId: string;
        snapshots: readonly ActionOperationSnapshotV1[];
        knownOperationKeys: ReadonlySet<string>;
    }>): void;
    retainAccountMachines(input: Readonly<{
        serverId: string;
        accountId: string;
        machineIds: ReadonlySet<string>;
    }>): void;
    setMachineObservation(address: ActionOperationMachineAddress, observation: ActionOperationObservation): void;
    markTerminalSeen(address: ActionOperationAddress, seenAt?: number): boolean;
    markAllTerminalSeen(seenAt?: number): boolean;
    dismissRecentSucceeded(): boolean;
    dismissUnavailable(address: ActionOperationAddress): boolean;
    markFollowUpNeedsAttention(input: Readonly<{
        serverId: string | null;
        accountId: string;
        requestId: string;
        message: string;
    }>): void;
    reset(): void;
}>;

const EMPTY_STATE: ActionOperationStoreSnapshot = Object.freeze({
    operationsByKey: new Map(),
    machineObservationByKey: new Map(),
    unavailableOperationKeys: new Set<string>(),
    seenAtByOperationKey: new Map(),
    dismissedRecentOperationKeys: new Set<string>(),
    dismissedUnavailableOperationKeys: new Set<string>(),
    followUpAttentionByRequestKey: new Map<string, string>(),
});

const TERMINAL_STATES: ReadonlySet<ActionOperationStateV1> = new Set(['succeeded', 'failed', 'cancelled']);

function canMergeSnapshot(current: ActionOperationSnapshotV1 | undefined, incoming: ActionOperationSnapshotV1): boolean {
    if (!current) return true;
    return canAdvanceActionOperationSnapshotV1(current, incoming);
}

function operationKey(operation: QualifiedActionOperation): string {
    return actionOperationAddressKey({ serverId: operation.serverId, operationId: operation.snapshot.operationId });
}

function machineKey(operation: QualifiedActionOperation): string {
    return actionOperationMachineAddressKey({ serverId: operation.serverId, machineId: operation.snapshot.scope.machineId });
}

function machineKeyHasServerId(key: string, serverId: string): boolean {
    try {
        const value: unknown = JSON.parse(key);
        return Array.isArray(value) && value.length === 2 && value[0] === serverId;
    } catch {
        return false;
    }
}

export function createActionOperationStore(): ActionOperationStore {
    let state = EMPTY_STATE;
    const listeners = new Set<() => void>();
    const publish = (next: ActionOperationStoreSnapshot) => {
        state = next;
        for (const listener of listeners) listener();
    };

    return {
        getSnapshot: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        mergeSnapshots(input) {
            const serverId = normalizeActionOperationServerId(input.serverId);
            if (!serverId) return;
            let operationsByKey: Map<string, QualifiedActionOperation> | null = null;
            let machineObservationByKey: Map<string, ActionOperationObservation> | null = null;
            let unavailableOperationKeys: Set<string> | null = null;
            let dismissedUnavailableOperationKeys: Set<string> | null = null;

            for (const snapshot of input.snapshots) {
                const incoming = qualifyActionOperationSnapshot(serverId, snapshot);
                const incomingOperationKey = operationKey(incoming);
                const incomingMachineKey = machineKey(incoming);
                if (state.unavailableOperationKeys.has(incomingOperationKey)) {
                    unavailableOperationKeys ??= new Set(state.unavailableOperationKeys);
                    unavailableOperationKeys.delete(incomingOperationKey);
                }
                if (state.dismissedUnavailableOperationKeys.has(incomingOperationKey)) {
                    dismissedUnavailableOperationKeys ??= new Set(state.dismissedUnavailableOperationKeys);
                    dismissedUnavailableOperationKeys.delete(incomingOperationKey);
                }
                if (!canMergeSnapshot((operationsByKey ?? state.operationsByKey).get(incomingOperationKey)?.snapshot, snapshot)) continue;
                operationsByKey ??= new Map(state.operationsByKey);
                operationsByKey.set(incomingOperationKey, incoming);
                if ((machineObservationByKey ?? state.machineObservationByKey).get(incomingMachineKey) !== 'available') {
                    machineObservationByKey ??= new Map(state.machineObservationByKey);
                    machineObservationByKey.set(incomingMachineKey, 'available');
                }
            }
            if (!operationsByKey && !machineObservationByKey && !unavailableOperationKeys && !dismissedUnavailableOperationKeys) return;
            publish(Object.freeze({
                ...state,
                operationsByKey: operationsByKey ?? state.operationsByKey,
                machineObservationByKey: machineObservationByKey ?? state.machineObservationByKey,
                unavailableOperationKeys: unavailableOperationKeys ?? state.unavailableOperationKeys,
                dismissedUnavailableOperationKeys: dismissedUnavailableOperationKeys ?? state.dismissedUnavailableOperationKeys,
            }));
        },
        reconcileMachineProjection(input) {
            const serverId = normalizeActionOperationServerId(input.serverId);
            if (!serverId) return;
            const listedOperationKeys = new Set(input.snapshots.map((snapshot) => actionOperationAddressKey({
                serverId,
                operationId: snapshot.operationId,
            })));
            let operationsByKey: Map<string, QualifiedActionOperation> | null = null;
            let seenAtByOperationKey: Map<string, Readonly<{ seenAt: number; revision: number }>> | null = null;
            let unavailableOperationKeys: Set<string> | null = null;
            let dismissedUnavailableOperationKeys: Set<string> | null = null;

            for (const [currentOperationKey, operation] of state.operationsByKey) {
                const snapshot = operation.snapshot;
                if (operation.serverId !== serverId || snapshot.scope.accountId !== input.accountId || snapshot.scope.machineId !== input.machineId) continue;
                if (listedOperationKeys.has(currentOperationKey)) {
                    if (state.unavailableOperationKeys.has(currentOperationKey)) {
                        unavailableOperationKeys ??= new Set(state.unavailableOperationKeys);
                        unavailableOperationKeys.delete(currentOperationKey);
                    }
                    if (state.dismissedUnavailableOperationKeys.has(currentOperationKey)) {
                        dismissedUnavailableOperationKeys ??= new Set(state.dismissedUnavailableOperationKeys);
                        dismissedUnavailableOperationKeys.delete(currentOperationKey);
                    }
                    continue;
                }
                if (!input.knownOperationKeys.has(currentOperationKey)) continue;
                if (!TERMINAL_STATES.has(snapshot.state)) {
                    if (!state.unavailableOperationKeys.has(currentOperationKey)) {
                        unavailableOperationKeys ??= new Set(state.unavailableOperationKeys);
                        unavailableOperationKeys.add(currentOperationKey);
                    }
                    continue;
                }
                operationsByKey ??= new Map(state.operationsByKey);
                operationsByKey.delete(currentOperationKey);
                if (state.seenAtByOperationKey.has(currentOperationKey)) {
                    seenAtByOperationKey ??= new Map(state.seenAtByOperationKey);
                    seenAtByOperationKey.delete(currentOperationKey);
                }
                if (state.dismissedUnavailableOperationKeys.has(currentOperationKey)) {
                    dismissedUnavailableOperationKeys ??= new Set(state.dismissedUnavailableOperationKeys);
                    dismissedUnavailableOperationKeys.delete(currentOperationKey);
                }
                if (state.unavailableOperationKeys.has(currentOperationKey)) {
                    unavailableOperationKeys ??= new Set(state.unavailableOperationKeys);
                    unavailableOperationKeys.delete(currentOperationKey);
                }
            }

            for (const snapshot of input.snapshots) {
                if (snapshot.scope.accountId !== input.accountId || snapshot.scope.machineId !== input.machineId) continue;
                const incoming = qualifyActionOperationSnapshot(serverId, snapshot);
                const incomingOperationKey = operationKey(incoming);
                if (!canMergeSnapshot((operationsByKey ?? state.operationsByKey).get(incomingOperationKey)?.snapshot, snapshot)) continue;
                operationsByKey ??= new Map(state.operationsByKey);
                operationsByKey.set(incomingOperationKey, incoming);
            }

            const scopedMachineKey = actionOperationMachineAddressKey({ serverId, machineId: input.machineId });
            let machineObservationByKey: Map<string, ActionOperationObservation> | null = null;
            if (state.machineObservationByKey.get(scopedMachineKey) !== 'available') {
                machineObservationByKey = new Map(state.machineObservationByKey);
                machineObservationByKey.set(scopedMachineKey, 'available');
            }
            if (!operationsByKey && !machineObservationByKey && !seenAtByOperationKey && !unavailableOperationKeys && !dismissedUnavailableOperationKeys) return;
            publish(Object.freeze({
                ...state,
                operationsByKey: operationsByKey ?? state.operationsByKey,
                machineObservationByKey: machineObservationByKey ?? state.machineObservationByKey,
                seenAtByOperationKey: seenAtByOperationKey ?? state.seenAtByOperationKey,
                unavailableOperationKeys: unavailableOperationKeys ?? state.unavailableOperationKeys,
                dismissedUnavailableOperationKeys: dismissedUnavailableOperationKeys ?? state.dismissedUnavailableOperationKeys,
            }));
        },
        retainAccountMachines(input) {
            const serverId = normalizeActionOperationServerId(input.serverId);
            if (!serverId) return;
            let operationsByKey: Map<string, QualifiedActionOperation> | null = null;
            let seenAtByOperationKey: Map<string, Readonly<{ seenAt: number; revision: number }>> | null = null;
            let unavailableOperationKeys: Set<string> | null = null;
            let dismissedUnavailableOperationKeys: Set<string> | null = null;
            for (const [currentOperationKey, operation] of state.operationsByKey) {
                const snapshot = operation.snapshot;
                if (operation.serverId !== serverId || snapshot.scope.accountId !== input.accountId || input.machineIds.has(snapshot.scope.machineId)) continue;
                operationsByKey ??= new Map(state.operationsByKey);
                operationsByKey.delete(currentOperationKey);
                if (state.seenAtByOperationKey.has(currentOperationKey)) {
                    seenAtByOperationKey ??= new Map(state.seenAtByOperationKey);
                    seenAtByOperationKey.delete(currentOperationKey);
                }
                if (state.unavailableOperationKeys.has(currentOperationKey)) {
                    unavailableOperationKeys ??= new Set(state.unavailableOperationKeys);
                    unavailableOperationKeys.delete(currentOperationKey);
                }
                if (state.dismissedUnavailableOperationKeys.has(currentOperationKey)) {
                    dismissedUnavailableOperationKeys ??= new Set(state.dismissedUnavailableOperationKeys);
                    dismissedUnavailableOperationKeys.delete(currentOperationKey);
                }
            }
            const retainedMachineKeys = new Set([...input.machineIds].map((machineId) => actionOperationMachineAddressKey({ serverId, machineId })));
            let machineObservationByKey: Map<string, ActionOperationObservation> | null = null;
            for (const currentMachineKey of state.machineObservationByKey.keys()) {
                if (!machineKeyHasServerId(currentMachineKey, serverId) || retainedMachineKeys.has(currentMachineKey)) continue;
                machineObservationByKey ??= new Map(state.machineObservationByKey);
                machineObservationByKey.delete(currentMachineKey);
            }
            if (!operationsByKey && !machineObservationByKey && !seenAtByOperationKey && !unavailableOperationKeys && !dismissedUnavailableOperationKeys) return;
            publish(Object.freeze({
                ...state,
                operationsByKey: operationsByKey ?? state.operationsByKey,
                machineObservationByKey: machineObservationByKey ?? state.machineObservationByKey,
                seenAtByOperationKey: seenAtByOperationKey ?? state.seenAtByOperationKey,
                unavailableOperationKeys: unavailableOperationKeys ?? state.unavailableOperationKeys,
                dismissedUnavailableOperationKeys: dismissedUnavailableOperationKeys ?? state.dismissedUnavailableOperationKeys,
            }));
        },
        setMachineObservation(address, observation) {
            const serverId = normalizeActionOperationServerId(address.serverId);
            if (!serverId) return;
            const key = actionOperationMachineAddressKey({ ...address, serverId });
            if (state.machineObservationByKey.get(key) === observation) return;
            const machineObservationByKey = new Map(state.machineObservationByKey);
            machineObservationByKey.set(key, observation);
            publish(Object.freeze({ ...state, machineObservationByKey }));
        },
        markTerminalSeen(address, seenAt = Date.now()) {
            const serverId = normalizeActionOperationServerId(address.serverId);
            if (!serverId) return false;
            const key = actionOperationAddressKey({ ...address, serverId });
            const qualifiedOperation = state.operationsByKey.get(key);
            const operation = qualifiedOperation?.snapshot;
            if (!qualifiedOperation || !operation || !TERMINAL_STATES.has(operation.state)) return false;
            const current = state.seenAtByOperationKey.get(key);
            const shouldAdvanceSeen = !current || current.revision < operation.revision;
            const followUpKey = operation.requestId
                ? actionOperationRequestAddressKey({
                    serverId: qualifiedOperation.serverId,
                    accountId: operation.scope.accountId,
                    requestId: operation.requestId,
                })
                : null;
            const shouldClearFollowUp = followUpKey !== null && state.followUpAttentionByRequestKey.has(followUpKey);
            if (!shouldAdvanceSeen && !shouldClearFollowUp) return false;
            const seenAtByOperationKey = shouldAdvanceSeen
                ? new Map(state.seenAtByOperationKey).set(key, { seenAt, revision: operation.revision })
                : state.seenAtByOperationKey;
            const clearedFollowUpAttentionByRequestKey = shouldClearFollowUp
                ? new Map(state.followUpAttentionByRequestKey)
                : null;
            if (clearedFollowUpAttentionByRequestKey && followUpKey) clearedFollowUpAttentionByRequestKey.delete(followUpKey);
            const followUpAttentionByRequestKey = clearedFollowUpAttentionByRequestKey ?? state.followUpAttentionByRequestKey;
            publish(Object.freeze({ ...state, seenAtByOperationKey, followUpAttentionByRequestKey }));
            return true;
        },
        markAllTerminalSeen(seenAt = Date.now()) {
            const seenAtByOperationKey = new Map(state.seenAtByOperationKey);
            const followUpAttentionByRequestKey = new Map(state.followUpAttentionByRequestKey);
            let changed = false;
            for (const [key, operation] of state.operationsByKey) {
                if (!TERMINAL_STATES.has(operation.snapshot.state)) continue;
                const current = seenAtByOperationKey.get(key);
                if (!current || current.seenAt < seenAt || current.revision < operation.snapshot.revision) {
                    seenAtByOperationKey.set(key, { seenAt, revision: operation.snapshot.revision });
                    changed = true;
                }
                const requestId = operation.snapshot.requestId;
                if (!requestId) continue;
                const followUpKey = actionOperationRequestAddressKey({
                    serverId: operation.serverId,
                    accountId: operation.snapshot.scope.accountId,
                    requestId,
                });
                if (followUpAttentionByRequestKey.delete(followUpKey)) changed = true;
            }
            if (!changed) return false;
            publish(Object.freeze({ ...state, seenAtByOperationKey, followUpAttentionByRequestKey }));
            return true;
        },
        dismissRecentSucceeded() {
            const dismissedRecentOperationKeys = new Set(state.dismissedRecentOperationKeys);
            let changed = false;
            for (const [key, operation] of state.operationsByKey) {
                if (operation.snapshot.state !== 'succeeded' || dismissedRecentOperationKeys.has(key)) continue;
                dismissedRecentOperationKeys.add(key);
                changed = true;
            }
            if (!changed) return false;
            publish(Object.freeze({ ...state, dismissedRecentOperationKeys }));
            return true;
        },
        dismissUnavailable(address) {
            const serverId = normalizeActionOperationServerId(address.serverId);
            if (!serverId) return false;
            const key = actionOperationAddressKey({ ...address, serverId });
            const operation = state.operationsByKey.get(key)?.snapshot;
            if (!operation || TERMINAL_STATES.has(operation.state) || !state.unavailableOperationKeys.has(key) || state.dismissedUnavailableOperationKeys.has(key)) return false;
            const dismissedUnavailableOperationKeys = new Set(state.dismissedUnavailableOperationKeys);
            dismissedUnavailableOperationKeys.add(key);
            publish(Object.freeze({ ...state, dismissedUnavailableOperationKeys }));
            return true;
        },
        markFollowUpNeedsAttention(input) {
            const serverId = normalizeActionOperationServerId(input.serverId);
            if (!serverId) return;
            const requestId = input.requestId.trim();
            const accountId = input.accountId.trim();
            const message = input.message.trim();
            if (!requestId || !accountId || !message) return;
            const key = actionOperationRequestAddressKey({ serverId, accountId, requestId });
            if (state.followUpAttentionByRequestKey.get(key) === message) return;
            const followUpAttentionByRequestKey = new Map(state.followUpAttentionByRequestKey);
            followUpAttentionByRequestKey.set(key, message);
            publish(Object.freeze({ ...state, followUpAttentionByRequestKey }));
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
