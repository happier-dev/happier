import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import {
    actionOperationStore,
    type ActionOperationStore,
} from './actionOperationStore';

function createAbortError(): Error {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Aborted', 'AbortError') as unknown as Error;
    }
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
}

function isTerminal(operation: ActionOperationSnapshotV1): boolean {
    return operation.state === 'succeeded'
        || operation.state === 'failed'
        || operation.state === 'cancelled';
}

export function observeActionOperationTerminal(params: Readonly<{
    accountId: string;
    machineId: string;
    actionId: string;
    requestId: string;
    signal?: AbortSignal;
    store?: ActionOperationStore;
}>): Promise<ActionOperationSnapshotV1> {
    const store = params.store ?? actionOperationStore;
    return new Promise((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        const cleanup = () => {
            unsubscribe();
            params.signal?.removeEventListener('abort', abort);
        };
        const finish = (operation: ActionOperationSnapshotV1) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(operation);
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(createAbortError());
        };
        const read = () => {
            for (const operation of store.getState().operationsById.values()) {
                if (
                    operation.scope.accountId === params.accountId
                    && operation.scope.machineId === params.machineId
                    && operation.actionId === params.actionId
                    && operation.requestId === params.requestId
                    && isTerminal(operation)
                ) {
                    finish(operation);
                    return;
                }
            }
        };

        if (params.signal?.aborted) {
            abort();
            return;
        }
        params.signal?.addEventListener('abort', abort, { once: true });
        unsubscribe = store.subscribe(read);
        read();
    });
}
