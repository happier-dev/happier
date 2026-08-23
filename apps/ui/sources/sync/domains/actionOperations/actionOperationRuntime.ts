import * as React from 'react';

import type {
    ActionOperationListV1Request,
    ActionOperationListV1Response,
    ActionOperationSnapshotV1,
} from '@happier-dev/protocol';

import { listActionOperations } from '@/sync/ops/actionOperations';
import { useActiveServerAccountScope, useAllMachines, useSocketStatus } from '@/sync/domains/state/storage';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { ActionOperationObservation } from './actionOperationStore';
import { actionOperationStore, type ActionOperationStore } from './actionOperationStore';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';

export type ActionOperationMachineRuntimeScope = Readonly<{
    accountId: string;
    machineId: string;
    serverId?: string | null;
}>;

type ListActionOperations = (params: Readonly<{
    machineId: string;
    serverId?: string | null;
    request?: ActionOperationListV1Request;
}>) => Promise<ActionOperationListV1Response>;

function runtimeScopeKey(scope: ActionOperationMachineRuntimeScope): string {
    return JSON.stringify([scope.accountId, scope.machineId, scope.serverId ?? null]);
}

function belongsToScope(
    snapshot: ActionOperationSnapshotV1,
    scope: ActionOperationMachineRuntimeScope,
): boolean {
    return snapshot.scope.accountId === scope.accountId && snapshot.scope.machineId === scope.machineId;
}

export async function reconcileActionOperationsOnce(params: Readonly<{
    scope: ActionOperationMachineRuntimeScope;
    store?: ActionOperationStore;
    list?: ListActionOperations;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const store = params.store ?? actionOperationStore;
    const list = params.list ?? listActionOperations;
    const shouldContinue = params.shouldContinue ?? (() => true);
    const knownOperationIds = new Set(
        [...store.getSnapshot().operationsById.values()]
            .filter((snapshot) => belongsToScope(snapshot, params.scope))
            .map((snapshot) => snapshot.operationId),
    );
    const listedSnapshots: ActionOperationSnapshotV1[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (shouldContinue()) {
        const response = await list({
            machineId: params.scope.machineId,
            serverId: params.scope.serverId,
            request: cursor ? { cursor } : {},
        });
        if (!shouldContinue()) return;

        const scopedSnapshots = response.items.filter((snapshot) => belongsToScope(snapshot, params.scope));
        listedSnapshots.push(...scopedSnapshots);

        if (!response.nextCursor || seenCursors.has(response.nextCursor)) break;
        seenCursors.add(response.nextCursor);
        cursor = response.nextCursor;
    }

    if (!shouldContinue()) return;
    store.reconcileMachineProjection({
        accountId: params.scope.accountId,
        machineId: params.scope.machineId,
        snapshots: listedSnapshots,
        knownOperationIds,
    });
}

export type ActionOperationMachineObserver = Readonly<{
    start(): void;
    stop(): void;
}>;

function createActionOperationMachineObserver(params: Readonly<{
    scope: ActionOperationMachineRuntimeScope;
    store?: ActionOperationStore;
    reconcileOnce?: typeof reconcileActionOperationsOnce;
}>): ActionOperationMachineObserver {
    const store = params.store ?? actionOperationStore;
    const reconcileOnce = params.reconcileOnce ?? reconcileActionOperationsOnce;
    let stopped = true;

    const run = async (): Promise<void> => {
        try {
            await reconcileOnce({
                scope: params.scope,
                store,
                shouldContinue: () => !stopped,
            });
        } catch {
            if (stopped) return;
            store.setMachineObservation(params.scope.machineId, 'reconnecting');
        }
    };

    return {
        start() {
            if (!stopped) return;
            stopped = false;
            void run();
        },
        stop() {
            if (stopped) return;
            stopped = true;
        },
    };
}

export function createActionOperationRuntimeCoordinator(params?: Readonly<{
    createObserver?: (scope: ActionOperationMachineRuntimeScope) => ActionOperationMachineObserver;
}>) {
    const observers = new Map<string, ActionOperationMachineObserver>();
    const createObserver = params?.createObserver ?? ((scope) => createActionOperationMachineObserver({ scope }));

    return {
        reconcile(scopes: readonly ActionOperationMachineRuntimeScope[]): void {
            const nextScopes = new Map<string, ActionOperationMachineRuntimeScope>();
            for (const scope of scopes) nextScopes.set(runtimeScopeKey(scope), scope);

            for (const [key, observer] of observers) {
                if (nextScopes.has(key)) continue;
                observer.stop();
                observers.delete(key);
            }
            for (const [key, scope] of nextScopes) {
                if (observers.has(key)) continue;
                const observer = createObserver(scope);
                observers.set(key, observer);
                observer.start();
            }
        },
        stopAll(): void {
            for (const observer of observers.values()) observer.stop();
            observers.clear();
        },
    };
}

export function bindActionOperationRuntimeToAccountLifetime(params: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    coordinator: Readonly<{ stopAll(): void }>;
    store?: ActionOperationStore;
}>): Readonly<{ dispose(): void }> {
    const store = params.store ?? actionOperationStore;
    return params.lifetime.onRetire(() => {
        params.coordinator.stopAll();
        store.reset();
        actionOperationPresentationCoordinator.reset();
    });
}

export function ActionOperationRuntime(): null {
    const accountScope = useActiveServerAccountScope();
    const machines = useAllMachines();
    const socket = useSocketStatus();
    const coordinator = React.useMemo(() => createActionOperationRuntimeCoordinator(), []);
    const accountLifetimeRef = React.useRef<ActiveServerAccountScopeLifetime | null>(null);
    const onlineMachineIds = React.useMemo(
        () => machines
            .filter((machine) => isMachineOnline(machine))
            .map((machine) => machine.id)
            .sort(),
        [machines],
    );
    const onlineMachineIdsKey = onlineMachineIds.join('\u0001');
    const accountId = accountScope?.accountId;
    const serverId = accountScope?.serverId;
    const scopes = React.useMemo<readonly ActionOperationMachineRuntimeScope[]>(() => {
        if (!accountId || socket.status !== 'connected') return [];
        return onlineMachineIds.map((machineId) => ({ accountId, machineId, serverId }));
    }, [accountId, onlineMachineIdsKey, serverId, socket.status]);

    React.useEffect(() => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || lifetime.scope.accountId !== accountId || lifetime.scope.serverId !== serverId) {
            coordinator.stopAll();
            actionOperationStore.reset();
            actionOperationPresentationCoordinator.reset();
            accountLifetimeRef.current = null;
            return;
        }
        if (accountLifetimeRef.current && accountLifetimeRef.current !== lifetime) {
            coordinator.stopAll();
            actionOperationStore.reset();
            actionOperationPresentationCoordinator.reset();
        }
        accountLifetimeRef.current = lifetime;
        const retirement = bindActionOperationRuntimeToAccountLifetime({ lifetime, coordinator });
        coordinator.reconcile(scopes);
        return () => retirement.dispose();
    }, [accountId, coordinator, scopes, serverId]);

    React.useEffect(() => {
        if (!accountId) return;
        actionOperationStore.retainAccountMachines(accountId, new Set(machines.map((machine) => machine.id)));
    }, [accountId, machines]);

    React.useEffect(() => {
        if (!accountId || socket.status === 'connected') return;
        const observation: ActionOperationObservation = socket.status === 'error'
            ? 'unavailable'
            : 'reconnecting';
        for (const machineId of onlineMachineIds) {
            actionOperationStore.setMachineObservation(machineId, observation);
        }
    }, [accountId, onlineMachineIdsKey, socket.status]);

    React.useEffect(() => () => {
        coordinator.stopAll();
        actionOperationStore.reset();
        actionOperationPresentationCoordinator.reset();
        accountLifetimeRef.current = null;
    }, [coordinator]);
    return null;
}

/** Observation ingress for non-polling callers; daemon state remains canonical. */
export function publishActionOperationObservation(input: Readonly<{
    machineId: string;
    observation: ActionOperationObservation;
    snapshots?: readonly ActionOperationSnapshotV1[];
}>): void {
    if (input.snapshots) actionOperationStore.mergeSnapshots(input.snapshots);
    actionOperationStore.setMachineObservation(input.machineId, input.observation);
}
