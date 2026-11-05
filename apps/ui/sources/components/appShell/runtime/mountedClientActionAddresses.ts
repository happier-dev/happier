import * as React from 'react';
import { workflowDraftClientRpcMethod } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { currentUiContextCommandClientRpcMethod, currentUiContextReadClientRpcMethod,
    mountedWorkReadClientRpcMethod, sessionUiActionClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { getMountedWorkflowDraftAddresses, subscribeMountedWorkflowDraftOwners } from '@/sync/ops/actions/workflowAuthoringAction';
import { getMountedWorkReadAddresses, subscribeMountedWorkReadOwners } from '@/sync/ops/actions/mountedWorkReadAction';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';

/** Address membership only; the mounted registries retain every editor and command. */
export function useMountedClientActionMethods(serverId: string | null, accountId: string | null): readonly string[] {
    const addresses = React.useSyncExternalStore(subscribeMountedWorkflowDraftOwners,
        getMountedWorkflowDraftAddresses, getMountedWorkflowDraftAddresses);
    const readAddresses = React.useSyncExternalStore(subscribeMountedWorkReadOwners,
        getMountedWorkReadAddresses, getMountedWorkReadAddresses);
    const reader = useOptionalCurrentUiContextReader();
    const subscribe = React.useCallback((listener: () => void) => reader?.subscribe(listener) ?? (() => {}), [reader]);
    const readMembership = React.useCallback(() => {
        const snapshot = reader?.readCurrentUiContext();
        return snapshot ? JSON.stringify([reader?.readCurrentSessionId?.() ?? null,
            snapshot.commands.map(command => command.id).sort()]) : null;
    }, [reader]);
    const membership = React.useSyncExternalStore(subscribe, readMembership, readMembership);
    const previous = React.useRef<readonly string[]>([]);
    return React.useMemo(() => {
        if (!serverId || !accountId) return [];
        const snapshot = reader?.readCurrentUiContext();
        const sessionId = reader?.readCurrentSessionId?.();
        const next = [...new Set([
            ...addresses.flatMap(address => address.scope.serverId === serverId && address.scope.accountId === accountId
                ? [workflowDraftClientRpcMethod(address), workflowDraftClientRpcMethod({ scope: address.scope })] : []),
            ...readAddresses.flatMap(address => address.scope.serverId === serverId && address.scope.accountId === accountId
                ? [mountedWorkReadClientRpcMethod(address.actionId, address.sessionId)] : []),
            ...(sessionId ? [sessionUiActionClientRpcMethod(sessionId)] : []),
            ...(snapshot ? [currentUiContextReadClientRpcMethod(), ...snapshot.commands.map(command =>
                currentUiContextCommandClientRpcMethod(command.id))] : []),
        ])].sort();
        if (next.length === previous.current.length && next.every((method, index) => previous.current[index] === method)) return previous.current;
        previous.current = next;
        return next;
    }, [serverId, accountId, addresses, readAddresses, reader, membership]);
}
