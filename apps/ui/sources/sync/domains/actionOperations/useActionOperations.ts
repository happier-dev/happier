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

export function useAllActionOperations() {
    return useActionOperationSelector(() => actionOperationSelectors.selectAll(actionOperationStore.getSnapshot()));
}

export function useActionOperation(operationId: string) {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), operationId)
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
