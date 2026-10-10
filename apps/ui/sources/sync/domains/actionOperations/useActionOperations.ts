import * as React from 'react';

import { actionOperationSelectors } from './actionOperationSelectors';
import { actionOperationStore } from './actionOperationStore';
import type { ActionOperationAddress, ActionOperationSessionAddress, ActionOperationProjectScriptQuery, ActionOperationProjectWorkspaceQuery, ActionOperationManagedMachineQuery } from './qualifiedActionOperation';

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

export function readInboxActionOperations() {
    return actionOperationSelectors.selectInbox(actionOperationStore.getSnapshot());
}

export function useInboxActionOperations() {
    return useActionOperationSelector(readInboxActionOperations);
}

export function useActionOperation(address: ActionOperationAddress) {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), address)
    ));
}

export function useActionOperationByRequestId(
    requestId: string | null,
    serverId: string | null,
    accountId?: string | null,
) {
    return useActionOperationSelector(() => (
        requestId
            ? actionOperationSelectors.selectSnapshotByRequestId(
                actionOperationStore.getSnapshot(),
                requestId,
                serverId,
                accountId,
            )
            : null
    ));
}

export function useActiveActionOperations() {
    return useActionOperationSelector(() => actionOperationSelectors.selectActive(actionOperationStore.getSnapshot()));
}

export function useSessionActionOperations(address: ActionOperationSessionAddress) {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectForSession(actionOperationStore.getSnapshot(), address)
    ));
}

export function useProjectScriptActionOperation(query: ActionOperationProjectScriptQuery) {
    return useActionOperationSelector(() => actionOperationSelectors.selectForProjectScript(actionOperationStore.getSnapshot(), query));
}

export function useProjectSetupActionOperation(query: ActionOperationProjectWorkspaceQuery) {
    return useActionOperationSelector(() => actionOperationSelectors.selectForProjectSetup(actionOperationStore.getSnapshot(), query));
}

export function useManagedMachineActionOperation(query: ActionOperationManagedMachineQuery) {
    return useActionOperationSelector(() => actionOperationSelectors.selectForManagedMachine(actionOperationStore.getSnapshot(), query));
}

export function useActionOperationsHaveAttention(): boolean {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectHasAttention(actionOperationStore.getSnapshot())
    ));
}

export function useActionOperationActivitySummary() {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectActivitySummary(actionOperationStore.getSnapshot())
    ));
}

export function useInboxActionOperationSummary() {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectInboxSummary(actionOperationStore.getSnapshot())
    ));
}

export function useActionOperationsHaveUnseenTerminal(): boolean {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectHasUnseenTerminal(actionOperationStore.getSnapshot())
    ));
}
