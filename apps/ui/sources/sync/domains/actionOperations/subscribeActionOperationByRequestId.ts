import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationSelectors } from './actionOperationSelectors';
import { actionOperationAddressKey } from './qualifiedActionOperation';
import { actionOperationStore, type ActionOperationStore } from './actionOperationStore';

type OperationSubscription = Readonly<{
    serverId: string | null;
    accountId?: string | null;
    onUpdate: (operation: ActionOperationSnapshotV1, snapshotComplete: boolean) => void;
    store?: ActionOperationStore;
}>;

export function subscribeActionOperationByRequestId(params: OperationSubscription & Readonly<{ requestId: string }>): () => void {
    return subscribeActionOperation(params);
}

export function subscribeActionOperation(params: OperationSubscription & (
    Readonly<{ requestId: string; operationId?: never }> | Readonly<{ operationId: string; requestId?: never }>
)): () => void {
    const store = params.store ?? actionOperationStore;
    let lastOperationId: string | null = null;
    let lastRevision = 0;
    let lastComplete = false;
    const read = () => {
        const state = store.getSnapshot();
        const operation = params.operationId !== undefined
            ? actionOperationSelectors.selectById(state, { serverId: params.serverId, operationId: params.operationId })?.snapshot
            : actionOperationSelectors.selectSnapshotByRequestId(state, params.requestId, params.serverId, params.accountId);
        if (!operation) return;
        const complete = state.operationsByKey.get(actionOperationAddressKey({
            serverId: params.serverId, operationId: operation.operationId,
        }))?.snapshotComplete === true;
        if (operation.operationId === lastOperationId && operation.revision <= lastRevision
            && !(operation.revision === lastRevision && complete && !lastComplete)) return;
        lastOperationId = operation.operationId;
        lastRevision = operation.revision;
        lastComplete = complete;
        params.onUpdate(operation, complete);
    };
    const unsubscribe = store.subscribe(read);
    read();
    return unsubscribe;
}
