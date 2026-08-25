import * as React from 'react';

import { actionOperationSelectors } from './actionOperationSelectors';
import { actionOperationStore } from './actionOperationStore';

function useActionOperationSelector<T>(selector: () => T): T {
    return React.useSyncExternalStore(
        actionOperationStore.subscribe,
        selector,
        selector,
    );
}

/** Imperative read for decision points that must not rely on a render snapshot. */
export function readAllActionOperations() {
    return actionOperationSelectors.selectAll(actionOperationStore.getSnapshot());
}

export function useAllActionOperations() {
    return useActionOperationSelector(readAllActionOperations);
}

export function useActionOperation(operationId: string) {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), operationId)
    ));
}

export function useActionOperationByRequestId(
    requestId: string | null,
    accountId?: string | null,
) {
    return useActionOperationSelector(() => (
        requestId
            ? actionOperationSelectors.selectSnapshotByRequestId(
                actionOperationStore.getSnapshot(),
                requestId,
                accountId,
            )
            : null
    ));
}

export function useActiveActionOperations() {
    return useActionOperationSelector(() => actionOperationSelectors.selectActive(actionOperationStore.getSnapshot()));
}

export function useSessionActionOperations(sessionId: string) {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectForSession(actionOperationStore.getSnapshot(), sessionId)
    ));
}

export function useActionOperationsHaveAttention(): boolean {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectHasAttention(actionOperationStore.getSnapshot())
    ));
}

export function useActionOperationsHaveUnseenTerminal(): boolean {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectHasUnseenTerminal(actionOperationStore.getSnapshot())
    ));
}
