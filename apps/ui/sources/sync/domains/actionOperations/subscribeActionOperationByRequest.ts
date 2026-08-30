import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import {
    actionOperationStore,
    type ActionOperationStore,
} from './actionOperationStore';

export function subscribeActionOperationByRequest(params: Readonly<{
    actionId: string;
    requestId: string;
    sessionId?: string;
    accountId?: string;
    machineId?: string;
    onUpdate: (operation: ActionOperationSnapshotV1) => void;
    store?: ActionOperationStore;
}>): () => void {
    const store = params.store ?? actionOperationStore;
    let lastOperationId: string | null = null;
    let lastRevision = 0;
    const read = () => {
        let latest: ActionOperationSnapshotV1 | null = null;
        for (const operation of store.getState().operationsById.values()) {
            if (
                operation.actionId !== params.actionId
                || operation.requestId !== params.requestId
                || (params.sessionId && operation.scope.sessionId !== params.sessionId)
                || (params.accountId && operation.scope.accountId !== params.accountId)
                || (params.machineId && operation.scope.machineId !== params.machineId)
            ) {
                continue;
            }
            if (!latest || operation.revision > latest.revision) latest = operation;
        }
        if (!latest || (latest.operationId === lastOperationId && latest.revision <= lastRevision)) return;
        lastOperationId = latest.operationId;
        lastRevision = latest.revision;
        params.onUpdate(latest);
    };

    const unsubscribe = store.subscribe(read);
    read();
    return unsubscribe;
}
