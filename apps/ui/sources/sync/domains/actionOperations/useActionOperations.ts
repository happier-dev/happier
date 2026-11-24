import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionOperationTerminalResultV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { useShallow } from 'zustand/react/shallow';

import { actionOperationSelectors, createActionOperationSelectors, selectTerminalActionOperationState, type DeploymentTargetLinkOperationQuery, type TerminalActionOperationQuery } from './actionOperationSelectors';
import { actionOperationStore, isActionOperationTerminal, type ActionOperationReadOwner } from './actionOperationStore';
import type { ActionOperationAddress, ActionOperationSessionAddress, ActionOperationProjectScriptQuery, ActionOperationProjectWorkspaceQuery, ActionOperationManagedMachineQuery, ActionOperationProjectServicesQuery } from './qualifiedActionOperation';
import type { ServerAccountScopeLifetime } from '../scope/serverAccountScope';
import type { ActionOperationProjectSourceQuery } from './qualifiedActionOperation';
import type { ActionOperationMachineSetupRunQuery, ActionOperationMachineSetupQuery } from './qualifiedActionOperation';

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

const NO_ATTEMPTS: ReturnType<typeof actionOperationSelectors.selectFailedAttempts> = Object.freeze([]);

/** Every failed attempt of a failed operation's work item, newest first (`selectFailedAttempts`). */
export function useFailedActionOperationAttempts(address: ActionOperationAddress | null) {
    return useActionOperationSelector(() => address
        ? actionOperationSelectors.selectFailedAttempts(actionOperationStore.getSnapshot(), address) : NO_ATTEMPTS);
}

export type AcceptedActionOperationRead = Readonly<{
    machineId: string;
    actionId: string;
    lifetime: ServerAccountScopeLifetime | null;
    /** Follow this admitted invocation before its first operation snapshot arrives. */
    requestId?: string;
}>;

/** A definitive owner absence can precede the first snapshot of an admitted operation. */
export function useActionOperationUnavailable(address: ActionOperationAddress | null, owner: ActionOperationReadOwner | undefined): boolean {
    return useActionOperationSelector(() => address !== null && owner !== undefined && actionOperationStore.isOperationUnavailable(address, owner));
}

export function useActionOperation(address: ActionOperationAddress | null, acceptedRead?: AcceptedActionOperationRead) {
    const serverId = address?.serverId ?? acceptedRead?.lifetime?.scope.serverId;
    const operationId = address?.operationId;
    const machineId = acceptedRead?.machineId;
    const actionId = acceptedRead?.actionId;
    const lifetime = acceptedRead?.lifetime;
    const requestId = acceptedRead?.requestId;
    const operation = useActionOperationSelector(() => {
        const state = actionOperationStore.getSnapshot();
        if (address) return actionOperationSelectors.selectById(state, address);
        if (!requestId || !serverId || !machineId || !actionId || !lifetime?.isCurrent()) return null;
        const snapshot = actionOperationSelectors.selectSnapshotByRequestId(state, requestId, serverId, lifetime.scope.accountId);
        if (snapshot?.actionId !== actionId || snapshot.scope.machineId !== machineId) return null;
        return actionOperationSelectors.selectById(state, { serverId, operationId: snapshot.operationId });
    });
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
    const read = () => (
        requestId
            ? actionOperationSelectors.selectSnapshotByRequestId(
                actionOperationStore.getSnapshot(),
                requestId,
                serverId,
                accountId,
            )
            : null
    );
    return React.useSyncExternalStore(requestId ? actionOperationStore.subscribe : subscribeToNothing, read, read);
}

/** A finite invocation can settle through its exact owner record while the original reply is still pending. */
export function useIssuedMachineActionOperation(input: Readonly<{
    requestId: string | null;
    machineId: string | undefined;
    actionId: string;
    lifetime: ServerAccountScopeLifetime | null;
    onSettled: (result: ActionExecuteResult, requestId: string) => void;
}>) {
    const { actionId, lifetime, machineId, onSettled } = input;
    const requestId = machineId ? input.requestId : null;
    const operation = useActionOperation(null, machineId && requestId ? { machineId, actionId, lifetime, requestId } : undefined);
    const complete = operation?.snapshotComplete ? operation.snapshot : null;
    React.useEffect(() => {
        if (!requestId || !complete || !lifetime?.isCurrent()) return;
        const terminal = readActionOperationTerminalResultV1(complete);
        if (terminal) onSettled(terminal, requestId);
    }, [complete, lifetime, onSettled, requestId]);
    return operation;
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

export function useProjectHeldSetupReviewOperations(accountId: string, workspaces: readonly WorkspaceAddressV1[]) {
    return useActionOperationSelector(useShallow(() =>
        actionOperationSelectors.selectHeldProjectSetupReviews(actionOperationStore.getSnapshot(), accountId, workspaces)));
}

export function useProjectServiceActionOperations(query: ActionOperationProjectServicesQuery) {
    return useActionOperationSelector(() => actionOperationSelectors.selectForProjectServices(actionOperationStore.getSnapshot(), query));
}

export function useManagedMachineActionOperation(query: ActionOperationManagedMachineQuery) {
    return useActionOperationSelector(() => actionOperationSelectors.selectForManagedMachine(actionOperationStore.getSnapshot(), query));
}

/** The retained root owns Setup lifecycle when its surface reopens. */
export function useMachineSetupActionOperation(query: ActionOperationMachineSetupQuery | null) {
    return useActionOperationSelector(() => query
        ? actionOperationSelectors.selectForMachineSetup(actionOperationStore.getSnapshot(), query) : null);
}

export function useMachineSetupRunActionOperation(query: ActionOperationMachineSetupRunQuery | null) {
    return useActionOperationSelector(() => query
        ? actionOperationSelectors.selectForMachineSetupRun(actionOperationStore.getSnapshot(), query) : null);
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
