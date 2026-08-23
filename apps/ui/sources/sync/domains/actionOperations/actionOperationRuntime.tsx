import * as React from 'react';

import type {
    ActionOperationListV1Request,
    ActionOperationListV1Response,
} from '@happier-dev/protocol';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import { listActionOperations } from '@/sync/ops/actionOperations';
import { useActiveServerAccountScope, useAllMachines, useSocketStatus } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import {
    actionOperationStore,
    type ActionOperationScope,
    type ActionOperationStore,
} from './actionOperationStore';

export type ActionOperationMachineRuntimeScope = ActionOperationScope & Readonly<{
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

/**
 * Connection-time recovery only. Live revisions arrive through the encrypted
 * account-scoped ephemeral stream, so this function deliberately performs no
 * wait, timer, retry, or follow-up scan.
 */
export async function reconcileActionOperationsOnce(params: Readonly<{
    scope: ActionOperationMachineRuntimeScope;
    store?: ActionOperationStore;
    list?: ListActionOperations;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const store = params.store ?? actionOperationStore;
    const list = params.list ?? listActionOperations;
    const shouldContinue = params.shouldContinue ?? (() => true);
    const seenCursors = new Set<string>();
    const listedOperationIds = new Set<string>();
    let cursor: string | undefined;

    while (shouldContinue()) {
        const response = await list({
            machineId: params.scope.machineId,
            serverId: params.scope.serverId,
            request: cursor ? { cursor } : {},
        });
        if (!shouldContinue()) return;
        for (const snapshot of response.items) {
            listedOperationIds.add(snapshot.operationId);
            store.merge(snapshot);
        }
        if (!response.nextCursor || seenCursors.has(response.nextCursor)) break;
        seenCursors.add(response.nextCursor);
        cursor = response.nextCursor;
    }

    if (!shouldContinue()) return;
    store.reconcileMachineList(params.scope, listedOperationIds);
}

type ReconcileOnce = (params: Readonly<{
    scope: ActionOperationMachineRuntimeScope;
    store: ActionOperationStore;
    shouldContinue: () => boolean;
}>) => Promise<void>;

export function createActionOperationRuntimeCoordinator(params?: Readonly<{
    store?: ActionOperationStore;
    reconcileOnce?: ReconcileOnce;
}>) {
    const store = params?.store ?? actionOperationStore;
    const reconcileOnce = params?.reconcileOnce ?? reconcileActionOperationsOnce;
    const activeByKey = new Map<string, Readonly<{
        scope: ActionOperationMachineRuntimeScope;
        token: { active: boolean };
    }>>();

    const begin = (scope: ActionOperationMachineRuntimeScope): void => {
        const token = { active: true };
        activeByKey.set(runtimeScopeKey(scope), { scope, token });
        void reconcileOnce({ scope, store, shouldContinue: () => token.active })
            .catch((error) => {
                if (!token.active) return;
                store.setObservation(
                    scope,
                    isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)
                        ? 'status_unavailable'
                        : 'reconnecting',
                );
            });
    };

    return {
        reconcile(scopes: readonly ActionOperationMachineRuntimeScope[]): void {
            const nextScopes = new Map<string, ActionOperationMachineRuntimeScope>();
            for (const scope of scopes) nextScopes.set(runtimeScopeKey(scope), scope);

            for (const [key, entry] of activeByKey) {
                if (nextScopes.has(key)) continue;
                entry.token.active = false;
                store.setObservation(entry.scope, 'status_unavailable');
                activeByKey.delete(key);
            }
            for (const [key, scope] of nextScopes) {
                if (activeByKey.has(key)) continue;
                begin(scope);
            }
        },
        stopAll(): void {
            for (const entry of activeByKey.values()) entry.token.active = false;
            activeByKey.clear();
        },
    };
}

export function ActionOperationRuntime(props: Readonly<{ enabled?: boolean }>): null {
    const accountScope = useActiveServerAccountScope();
    const machines = useAllMachines();
    const socket = useSocketStatus();
    const coordinator = React.useMemo(() => createActionOperationRuntimeCoordinator(), []);
    const machineIdsKey = machines
        .filter((machine) => isMachineOnline(machine))
        .map((machine) => machine.id)
        .sort()
        .join('\u0001');
    const accountId = accountScope?.accountId ?? null;
    const serverId = accountScope?.serverId ?? null;
    const scopes = React.useMemo<readonly ActionOperationMachineRuntimeScope[]>(() => {
        if (props.enabled === false || !accountId || !serverId || socket.status !== 'connected') return [];
        return machineIdsKey ? machineIdsKey.split('\u0001').map((machineId) => ({
            accountId,
            machineId,
            serverId,
        })) : [];
    }, [accountId, machineIdsKey, props.enabled, serverId, socket.status]);

    React.useEffect(() => {
        coordinator.reconcile(scopes);
    }, [coordinator, scopes]);

    React.useEffect(() => {
        if (props.enabled === false || !accountId || socket.status === 'connected') return;
        const observation = socket.status === 'error' ? 'status_unavailable' : 'reconnecting';
        for (const machineId of machineIdsKey ? machineIdsKey.split('\u0001') : []) {
            actionOperationStore.setObservation({ accountId, machineId }, observation);
        }
    }, [accountId, machineIdsKey, props.enabled, socket.status]);

    React.useEffect(() => () => coordinator.stopAll(), [coordinator]);
    return null;
}
