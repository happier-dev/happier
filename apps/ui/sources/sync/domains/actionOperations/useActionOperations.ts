import * as React from 'react';

import { actionOperationSelectors, createActionOperationSelectors, selectTerminalActionOperationState, type DeploymentTargetLinkOperationQuery, type TerminalActionOperationQuery } from './actionOperationSelectors';
import { actionOperationStore, isActionOperationTerminal } from './actionOperationStore';
import type { ActionOperationAddress, ActionOperationSessionAddress, ActionOperationProjectScriptQuery, ActionOperationProjectWorkspaceQuery, ActionOperationManagedMachineQuery, ActionOperationProjectServicesQuery } from './qualifiedActionOperation';
import type { ServerAccountScopeLifetime } from '../scope/serverAccountScope';
import type { ActionOperationProjectSourceQuery } from './qualifiedActionOperation';

function useActionOperationSelector<T>(selector: () => T): T {
    return React.useSyncExternalStore(
        actionOperationStore.subscribe,
        selector,
        selector,
    );
}

const subscribeToNothing = () => () => {};

/** Only a mounted borrowed terminal subscribes, and it observes a stable scalar outcome. */
export function useTerminalActionOperationState(query: TerminalActionOperationQuery) {
    const read = () => selectTerminalActionOperationState(actionOperationStore.getSnapshot(), query);
    return React.useSyncExternalStore(query.terminalId ? actionOperationStore.subscribe : subscribeToNothing, read, read);
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

export type AcceptedActionOperationRead = Readonly<{
    machineId: string;
    actionId: string;
    lifetime: ServerAccountScopeLifetime | null;
    /** Follow this admitted invocation before its first operation snapshot arrives. */
    requestId?: string;
}>;

export function useActionOperation(address: ActionOperationAddress | null, acceptedRead?: AcceptedActionOperationRead) {
    const operation = useActionOperationSelector(() => (
        address ? actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), address) : null
    ));
    const serverId = address?.serverId ?? acceptedRead?.lifetime?.scope.serverId;
    const operationId = address?.operationId;
    const machineId = acceptedRead?.machineId;
    const actionId = acceptedRead?.actionId;
    const lifetime = acceptedRead?.lifetime;
    const requestId = acceptedRead?.requestId;
    const terminalComplete = operation?.snapshotComplete === true && isActionOperationTerminal(operation.snapshot.state);
    React.useEffect(() => {
        if (!serverId || !machineId || !actionId || !lifetime || terminalComplete || !lifetime.isCurrent()) return;
        const identity = requestId ? { requestIdentity: { actionId, requestId } } : operationId ? { operationId, actionId } : null;
        if (!identity) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const current = () => !controller.signal.aborted && lifetime.isCurrent();
        const unavailable = () => {
            if (current()) actionOperationStore.setMachineObservation({ serverId, machineId }, 'unavailable');
        };
        // A shared requester has no custodian Account push. The existing observer
        // joins its finite runner and retains demand through transport recovery.
        void (async () => {
            try {
                const { observeActionOperation } = await import('./observeActionOperationByRequestId');
                if (!current()) return;
                await observeActionOperation({ serverId, machineId, accountId: lifetime.scope.accountId,
                    ...identity, signal: controller.signal, onUnavailable: unavailable,
                    onUpdate: snapshot => {
                        if (current()) actionOperationStore.mergeSnapshots({ serverId, snapshots: [snapshot] });
                    } });
            } catch { unavailable(); }
            finally { retirement.dispose(); }
        })();
        return () => { controller.abort(); retirement.dispose(); };
    }, [serverId, requestId ? undefined : operationId, requestId, machineId, actionId, lifetime, terminalComplete]);
    return operation;
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

export function useMachineRebootActionOperations(scope: Readonly<{ serverId: string; accountId: string }> | null) {
    const read = React.useMemo(() => {
        const selectors = createActionOperationSelectors();
        return () => selectors.selectMachineReboots(actionOperationStore.getSnapshot(), scope);
    }, [scope]);
    return useActionOperationSelector(read);
}

export function useDeploymentTargetLinkOperations(query: DeploymentTargetLinkOperationQuery) {
    const { serverId, accountId, machineId, environmentId } = query;
    const read = React.useMemo(() => {
        const selectors = createActionOperationSelectors();
        const scope = { serverId, accountId, machineId, environmentId };
        return () => selectors.selectDeploymentTargetLinks(actionOperationStore.getSnapshot(), scope);
    }, [serverId, accountId, machineId, environmentId]);
    return useActionOperationSelector(read);
}

export function useSessionActionOperations(address: ActionOperationSessionAddress) {
    return useActionOperationSelector(() => (
        actionOperationSelectors.selectForSession(actionOperationStore.getSnapshot(), address)
    ));
}

export function useProjectScriptActionOperation(query: ActionOperationProjectScriptQuery) {
    return useActionOperationSelector(() => actionOperationSelectors.selectForProjectScript(actionOperationStore.getSnapshot(), query));
}

export function useProjectOpenActionOperation(query: ActionOperationProjectSourceQuery) {
    return useActionOperationSelector(() => actionOperationSelectors.selectForProjectOpen(actionOperationStore.getSnapshot(), query));
}

export function useProjectSetupActionOperation(query: ActionOperationProjectWorkspaceQuery | null) {
    return useActionOperationSelector(() => query ? actionOperationSelectors.selectForProjectSetup(actionOperationStore.getSnapshot(), query) : null);
}

export function useProjectHeldSetupReviewOperation(query: ActionOperationProjectWorkspaceQuery) {
    return useActionOperationSelector(() => actionOperationSelectors.selectHeldProjectSetupReview(actionOperationStore.getSnapshot(), query));
}

export function useProjectServiceActionOperations(query: ActionOperationProjectServicesQuery) {
    return useActionOperationSelector(() => actionOperationSelectors.selectForProjectServices(actionOperationStore.getSnapshot(), query));
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
