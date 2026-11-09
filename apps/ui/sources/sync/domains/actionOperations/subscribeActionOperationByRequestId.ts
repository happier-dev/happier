import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationSelectors } from './actionOperationSelectors';
import { actionOperationStore, type ActionOperationStore } from './actionOperationStore';

export function subscribeActionOperationByRequestId(params: Readonly<{
    requestId: string;
    serverId: string | null;
    accountId?: string | null;
    onUpdate: (operation: ActionOperationSnapshotV1) => void;
    store?: ActionOperationStore;
}>): () => void {
    const store = params.store ?? actionOperationStore;
    let lastOperationId: string | null = null;
    let lastRevision = 0;
    const read = () => {
        const operation = actionOperationSelectors.selectSnapshotByRequestId(
            store.getSnapshot(),
            params.requestId,
            params.serverId,
            params.accountId,
        );
        if (!operation || (operation.operationId === lastOperationId && operation.revision <= lastRevision)) return;
        lastOperationId = operation.operationId;
        lastRevision = operation.revision;
        params.onUpdate(operation);
    };
    const unsubscribe = store.subscribe(read);
    read();
    return unsubscribe;
}
