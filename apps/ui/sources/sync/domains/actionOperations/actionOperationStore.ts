import { canAdvanceActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createActionOperationAcknowledgementPersistence } from './actionOperationAcknowledgements';
import { createWorkerStatusChanges } from './workerStatusChanges';
import { type ServerAccountScope } from '../scope/serverAccountScope';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionOperationSnapshotV1, ActionOperationStateV1, MachineServiceRowV1 } from '@happier-dev/protocol';

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

/** Ordinary admitted Machine facts, not a second reboot receipt or authority. */
export type MachineRebootReadFacts = Readonly<{
    installationId: string | null;
    bootedAt: number | null;
    services: readonly MachineServiceRowV1[] | null;
}>;

/** A held review waits on a person; the Machine is observed normally while it does. */
export function isActionOperationReviewHeld(snapshot: ActionOperationSnapshotV1): boolean {
    return snapshot.observation?.kind === 'review_required';
}

/** Activity and Inbox share the same eligibility; held reviews require a decision. */
export function canDismissActionOperation(
    snapshot: ActionOperationSnapshotV1,
    isUnavailableProjection: boolean,
    hasFollowUpAttention = false,
): boolean {
    if (isActionOperationReviewHeld(snapshot)) return false;
    return snapshot.state === 'failed' || snapshot.state === 'succeeded' && hasFollowUpAttention
        || !isActionOperationTerminal(snapshot.state) && isUnavailableProjection;
}

/** Reachable transport cannot erase the execution owner's uncertainty about an active outcome. */
export function resolveActionOperationObservation(
    snapshot: ActionOperationSnapshotV1,
    transportObservation: ActionOperationObservation,
): ActionOperationObservation {
    return snapshot.observation && !isActionOperationReviewHeld(snapshot) ? 'unavailable' : transportObservation;
}

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
    readWorkerStatusRevision(scope: ServerAccountScope, machineId: string): number;
    subscribeWorkerStatus(scope: ServerAccountScope, machineIds: readonly string[], listener: () => void): () => void;
    mergeSnapshots(input: Readonly<{ serverId: string | null; snapshots: readonly ActionOperationSnapshotV1[] }>): void;
    reobserveMachineAgentIsolation(input: Readonly<{
        serverId: string; accountId: string; machineId: string; operationId: string;
        recovery: NonNullable<QualifiedActionOperation['agentIsolationRecovery']>;
    }>): void;
    reobserveMachineReboot(input: Readonly<{
        serverId: string;
        accountId: string;
        machineId: string;
        operationId: string;
        facts: MachineRebootReadFacts | null;
    }>): void;
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
    dismissOperation(address: ActionOperationAddress): boolean;
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
    const persistence = createActionOperationAcknowledgementPersistence();
    const hydrateScope = (scope: ServerAccountScope) => {
        const entries = persistence.hydrate(scope);
        if (entries.length === 0) return;
        const seenAtByOperationKey = new Map(state.seenAtByOperationKey);
        const dismissedRecentOperationKeys = new Set(state.dismissedRecentOperationKeys);
        for (const entry of entries) {
            const key = actionOperationAddressKey({ serverId: scope.serverId, operationId: entry.operationId });
            // The predecessor has no revision acknowledgement. Bind it once to
            // the first terminal replay, then use current revision semantics.
            if (entry.seenAt !== undefined) seenAtByOperationKey.set(key, { seenAt: entry.seenAt, revision: entry.seenRevision ?? -1 });
            if (entry.dismissed) dismissedRecentOperationKeys.add(key);
        }
        state = Object.freeze({ ...state, seenAtByOperationKey, dismissedRecentOperationKeys });
    };
    const bindPredecessorSeenRevision = (
        operation: QualifiedActionOperation,
        pending: Map<string, Readonly<{ seenAt: number; revision: number }>> | null,
    ) => {
        if (!TERMINAL_STATES.has(operation.snapshot.state)) return pending;
        const key = operationKey(operation);
        const seenAtByOperationKey = pending ?? state.seenAtByOperationKey;
        const seen = seenAtByOperationKey.get(key);
        return seen?.revision === -1
            ? new Map(seenAtByOperationKey).set(key, { ...seen, revision: operation.snapshot.revision })
            : pending;
    };
    const listeners = new Set<() => void>();
    const workerStatusChanges = createWorkerStatusChanges();
    const publish = (next: ActionOperationStoreSnapshot, persist = true, changedOperationKeys: Iterable<string> = []) => {
        if (persist && (next.seenAtByOperationKey !== state.seenAtByOperationKey
            || next.dismissedRecentOperationKeys !== state.dismissedRecentOperationKeys)) {
            persistence.save(next);
        }
        const previous = state;
        state = next;
        if (previous.operationsByKey !== next.operationsByKey) workerStatusChanges.publish(previous.operationsByKey, next.operationsByKey, changedOperationKeys);
        for (const listener of listeners) listener();
    };

    const store: ActionOperationStore = {
        getSnapshot: () => state,
        readWorkerStatusRevision: workerStatusChanges.read,
        subscribeWorkerStatus: workerStatusChanges.subscribe,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        mergeSnapshots(input) {
            const serverId = normalizeActionOperationServerId(input.serverId);
            if (!serverId) return;
            let operationsByKey: Map<string, QualifiedActionOperation> | null = null;
            let seenAtByOperationKey: Map<string, Readonly<{ seenAt: number; revision: number }>> | null = null;
            let machineObservationByKey: Map<string, ActionOperationObservation> | null = null;
            let unavailableOperationKeys: Set<string> | null = null;
            let dismissedUnavailableOperationKeys: Set<string> | null = null;

            for (const snapshot of input.snapshots) {
                hydrateScope({ serverId, accountId: snapshot.scope.accountId });
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
                const current = (operationsByKey ?? state.operationsByKey).get(incomingOperationKey);
                if (!canMergeSnapshot(current?.snapshot, snapshot)) continue;
                seenAtByOperationKey = bindPredecessorSeenRevision(incoming, seenAtByOperationKey);
                // A new revision of the uncertain old receipt cannot erase a
                // fresh Machine CHECK. Terminal/review or scope changes retire it.
                const recovery = snapshot.actionId === 'machines.agentIsolation.set'
                    && snapshot.observation?.kind === 'outcome_uncertain' && !TERMINAL_STATES.has(snapshot.state)
                    && current?.snapshot.scope.accountId === snapshot.scope.accountId
                    && current.snapshot.scope.machineId === snapshot.scope.machineId ? current.agentIsolationRecovery : undefined;
                operationsByKey ??= new Map(state.operationsByKey);
                operationsByKey.set(incomingOperationKey, recovery ? Object.freeze({ ...incoming, agentIsolationRecovery: recovery }) : incoming);
                if ((machineObservationByKey ?? state.machineObservationByKey).get(incomingMachineKey) !== 'available') {
                    machineObservationByKey ??= new Map(state.machineObservationByKey);
                    machineObservationByKey.set(incomingMachineKey, 'available');
                }
            }
            if (!operationsByKey && !machineObservationByKey && !unavailableOperationKeys && !dismissedUnavailableOperationKeys) return;
            publish(Object.freeze({
                ...state,
                operationsByKey: operationsByKey ?? state.operationsByKey,
                seenAtByOperationKey: seenAtByOperationKey ?? state.seenAtByOperationKey,
                machineObservationByKey: machineObservationByKey ?? state.machineObservationByKey,
                unavailableOperationKeys: unavailableOperationKeys ?? state.unavailableOperationKeys,
                dismissedUnavailableOperationKeys: dismissedUnavailableOperationKeys ?? state.dismissedUnavailableOperationKeys,
            }), true, input.snapshots.map(snapshot => actionOperationAddressKey({ serverId, operationId: snapshot.operationId })));
        },
        reobserveMachineAgentIsolation(input) {
            const key = actionOperationAddressKey(input);
            const current = state.operationsByKey.get(key);
            const snapshot = current?.snapshot;
            if (!current || !snapshot || snapshot.actionId !== 'machines.agentIsolation.set'
                || TERMINAL_STATES.has(snapshot.state) || snapshot.scope.accountId !== input.accountId
                || snapshot.scope.machineId !== input.machineId
                || snapshot.observation?.kind !== 'outcome_uncertain'
                || sameStrictJsonValue(current.agentIsolationRecovery, input.recovery)) return;
            const operationsByKey = new Map(state.operationsByKey);
            operationsByKey.set(key, Object.freeze({ ...current, agentIsolationRecovery: Object.freeze(input.recovery) }));
            publish(Object.freeze({ ...state, operationsByKey }), true, [key]);
        },
        reobserveMachineReboot(input) {
            const serverId = normalizeActionOperationServerId(input.serverId);
            if (!serverId) return;
            const key = actionOperationAddressKey({ serverId, operationId: input.operationId });
            const current = state.operationsByKey.get(key)?.snapshot;
            if (!current || !state.unavailableOperationKeys.has(key) || TERMINAL_STATES.has(current.state)
                || current.actionId !== 'machines.reboot' || current.domainRef?.kind !== 'machineReboot'
                || current.scope.accountId !== input.accountId || current.scope.machineId !== input.machineId) return;
            const basis = current.domainRef.basis;
            const facts = input.facts;
            const rows = new Map(facts?.services?.map(row => [row.serviceId, row]));
            const expected = basis?.expectedRunningServiceIds.map(id => rows.get(id)) ?? [];
            const restored = !!basis?.dispatchStarted && basis.expectedRunningServicesKnown
                && facts?.installationId === current.domainRef.installationId
                && facts.bootedAt !== null && facts.bootedAt !== basis.bootedAt && facts.services !== null
                && expected.every(row => !!row && !row.unavailableReason
                    && (row.state === 'healthy' || row.state === 'running')
                    && (!row.native || row.native.phase === 'running' && row.native.readiness !== 'not_ready'));
            if (!restored && current.observation?.kind === 'outcome_uncertain'
                && current.observation.code === 'action_outcome_unknown') return;
            const { observation: _oldObservation, error: _oldError, ...retained } = current;
            const next: ActionOperationSnapshotV1 = restored && basis ? {
                ...retained, revision: current.revision + 1, state: 'succeeded', cancellation: 'unsupported',
                settledAt: Math.max(current.startedAt ?? current.createdAt, Date.now()),
                progress: { kind: 'phase', label: current.title, phase: expected.some(row => row?.state !== 'healthy'
                    && row?.native?.readiness !== 'ready') ? 'reboot.restored_unverified' : 'reboot.restored' },
                result: { kind: 'accepted', operation: { operationId: current.operationId }, bootedAt: basis.bootedAt },
            } : { ...current, revision: current.revision + 1,
                observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } };
            const operationsByKey = new Map(state.operationsByKey);
            operationsByKey.set(key, qualifyActionOperationSnapshot(serverId, next));
            const unavailableOperationKeys = new Set(state.unavailableOperationKeys);
            if (restored) unavailableOperationKeys.delete(key);
            publish(Object.freeze({ ...state, operationsByKey, unavailableOperationKeys }), true, [key]);
        },
        reconcileMachineProjection(input) {
            const serverId = normalizeActionOperationServerId(input.serverId);
            if (!serverId) return;
            hydrateScope({ serverId, accountId: input.accountId });
            const listedOperationKeys = new Set(input.snapshots.map((snapshot) => actionOperationAddressKey({
                serverId,
                operationId: snapshot.operationId,
            })));
            let operationsByKey: Map<string, QualifiedActionOperation> | null = null;
            let seenAtByOperationKey: Map<string, Readonly<{ seenAt: number; revision: number }>> | null = null;
            let unavailableOperationKeys: Set<string> | null = null;
            let dismissedUnavailableOperationKeys: Set<string> | null = null;
            let dismissedRecentOperationKeys: Set<string> | null = null;
            // The complete list cannot retire decisions for rows accepted after
            // its read began, just as it cannot retire those snapshots.
            const retainedAcknowledgementKeys = new Set(listedOperationKeys);
            for (const [currentOperationKey, operation] of state.operationsByKey) {
                const snapshot = operation.snapshot;
                if (operation.serverId !== serverId || snapshot.scope.accountId !== input.accountId || snapshot.scope.machineId !== input.machineId) continue;
                if (!input.knownOperationKeys.has(currentOperationKey)) retainedAcknowledgementKeys.add(currentOperationKey);
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
                // This surviving holder proved recovery after the target lost its
                // in-memory receipt. A later empty daemon list cannot erase it.
                if (snapshot.actionId === 'machines.reboot' && snapshot.domainRef?.kind === 'machineReboot'
                    && snapshot.state === 'succeeded' && snapshot.progress?.kind === 'phase'
                    && (snapshot.progress.phase === 'reboot.restored' || snapshot.progress.phase === 'reboot.restored_unverified')) {
                    retainedAcknowledgementKeys.add(currentOperationKey);
                    continue;
                }
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

            for (const key of persistence.prune({ serverId, accountId: input.accountId },
                machineId => machineId !== input.machineId, retainedAcknowledgementKeys)) {
                seenAtByOperationKey ??= new Map(state.seenAtByOperationKey);
                seenAtByOperationKey.delete(key);
                dismissedRecentOperationKeys ??= new Set(state.dismissedRecentOperationKeys);
                dismissedRecentOperationKeys.delete(key);
            }

            for (const snapshot of input.snapshots) {
                if (snapshot.scope.accountId !== input.accountId || snapshot.scope.machineId !== input.machineId) continue;
                const incoming = qualifyActionOperationSnapshot(serverId, snapshot);
                const incomingOperationKey = operationKey(incoming);
                if (!canMergeSnapshot((operationsByKey ?? state.operationsByKey).get(incomingOperationKey)?.snapshot, snapshot)) continue;
                operationsByKey ??= new Map(state.operationsByKey);
                seenAtByOperationKey = bindPredecessorSeenRevision(incoming, seenAtByOperationKey);
                operationsByKey.set(incomingOperationKey, incoming);
            }

            const scopedMachineKey = actionOperationMachineAddressKey({ serverId, machineId: input.machineId });
            let machineObservationByKey: Map<string, ActionOperationObservation> | null = null;
            if (state.machineObservationByKey.get(scopedMachineKey) !== 'available') {
                machineObservationByKey = new Map(state.machineObservationByKey);
                machineObservationByKey.set(scopedMachineKey, 'available');
            }
            if (!operationsByKey && !machineObservationByKey && !seenAtByOperationKey && !unavailableOperationKeys && !dismissedUnavailableOperationKeys && !dismissedRecentOperationKeys) return;
            publish(Object.freeze({
                ...state,
                operationsByKey: operationsByKey ?? state.operationsByKey,
                machineObservationByKey: machineObservationByKey ?? state.machineObservationByKey,
                seenAtByOperationKey: seenAtByOperationKey ?? state.seenAtByOperationKey,
                dismissedRecentOperationKeys: dismissedRecentOperationKeys ?? state.dismissedRecentOperationKeys,
                unavailableOperationKeys: unavailableOperationKeys ?? state.unavailableOperationKeys,
                dismissedUnavailableOperationKeys: dismissedUnavailableOperationKeys ?? state.dismissedUnavailableOperationKeys,
            }), true, new Set([...input.knownOperationKeys, ...listedOperationKeys]));
        },
        retainAccountMachines(input) {
            const serverId = normalizeActionOperationServerId(input.serverId);
            if (!serverId) return;
            hydrateScope({ serverId, accountId: input.accountId });
            let operationsByKey: Map<string, QualifiedActionOperation> | null = null;
            let seenAtByOperationKey: Map<string, Readonly<{ seenAt: number; revision: number }>> | null = null;
            let unavailableOperationKeys: Set<string> | null = null;
            let dismissedUnavailableOperationKeys: Set<string> | null = null;
            let dismissedRecentOperationKeys: Set<string> | null = null;
            const changedOperationKeys = new Set<string>();
            for (const key of persistence.prune({ serverId, accountId: input.accountId }, machineId => input.machineIds.has(machineId))) {
                seenAtByOperationKey ??= new Map(state.seenAtByOperationKey);
                seenAtByOperationKey.delete(key);
                dismissedRecentOperationKeys ??= new Set(state.dismissedRecentOperationKeys);
                dismissedRecentOperationKeys.delete(key);
            }
            for (const [currentOperationKey, operation] of state.operationsByKey) {
                const snapshot = operation.snapshot;
                if (operation.serverId !== serverId || snapshot.scope.accountId !== input.accountId || input.machineIds.has(snapshot.scope.machineId)) continue;
                operationsByKey ??= new Map(state.operationsByKey);
                operationsByKey.delete(currentOperationKey);
                changedOperationKeys.add(currentOperationKey);
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
            if (!operationsByKey && !machineObservationByKey && !seenAtByOperationKey && !unavailableOperationKeys && !dismissedUnavailableOperationKeys && !dismissedRecentOperationKeys) return;
            publish(Object.freeze({
                ...state,
                operationsByKey: operationsByKey ?? state.operationsByKey,
                machineObservationByKey: machineObservationByKey ?? state.machineObservationByKey,
                seenAtByOperationKey: seenAtByOperationKey ?? state.seenAtByOperationKey,
                dismissedRecentOperationKeys: dismissedRecentOperationKeys ?? state.dismissedRecentOperationKeys,
                unavailableOperationKeys: unavailableOperationKeys ?? state.unavailableOperationKeys,
                dismissedUnavailableOperationKeys: dismissedUnavailableOperationKeys ?? state.dismissedUnavailableOperationKeys,
            }), true, changedOperationKeys);
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
                const requestId = operation.snapshot.requestId;
                if (requestId && state.followUpAttentionByRequestKey.has(actionOperationRequestAddressKey({
                    serverId: operation.serverId, accountId: operation.snapshot.scope.accountId, requestId,
                }))) continue;
                dismissedRecentOperationKeys.add(key);
                changed = true;
            }
            if (!changed) return false;
            publish(Object.freeze({ ...state, dismissedRecentOperationKeys }));
            return true;
        },
        dismissOperation(address) {
            const key = actionOperationAddressKey(address);
            const qualified = state.operationsByKey.get(key);
            if (!qualified) return false;
            const operation = qualified.snapshot;
            const followUpKey = operation.requestId ? actionOperationRequestAddressKey({ serverId: qualified.serverId,
                accountId: operation.scope.accountId, requestId: operation.requestId }) : null;
            const hasFollowUpAttention = followUpKey !== null && state.followUpAttentionByRequestKey.has(followUpKey);
            if (!canDismissActionOperation(operation, state.unavailableOperationKeys.has(key), hasFollowUpAttention)) return false;
            if (operation.state === 'failed') {
                if (state.dismissedRecentOperationKeys.has(key)) return false;
                const dismissedRecentOperationKeys = new Set(state.dismissedRecentOperationKeys).add(key);
                publish(Object.freeze({ ...state, dismissedRecentOperationKeys }));
                return true;
            }
            return hasFollowUpAttention ? store.markTerminalSeen(address) : store.dismissUnavailable(address);
        },
        dismissUnavailable(address) {
            const serverId = normalizeActionOperationServerId(address.serverId);
            if (!serverId) return false;
            const key = actionOperationAddressKey({ ...address, serverId });
            const operation = state.operationsByKey.get(key)?.snapshot;
            if (!operation || isActionOperationReviewHeld(operation) || TERMINAL_STATES.has(operation.state) || !state.unavailableOperationKeys.has(key) || state.dismissedUnavailableOperationKeys.has(key)) return false;
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
            persistence.reset();
            if (state === EMPTY_STATE) return;
            publish(EMPTY_STATE, false, state.operationsByKey.keys());
        },
    };
    return store;
}

export const actionOperationStore = createActionOperationStore();

export function isActionOperationTerminal(state: ActionOperationStateV1): boolean {
    return TERMINAL_STATES.has(state);
}
