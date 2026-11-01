import * as React from 'react';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { createUiClientActionReverseHandler } from '@/sync/ops/actions/clientActionReverseDispatch';
import { getMountedWorkflowDraftAddresses, subscribeMountedWorkflowDraftOwners } from '@/sync/ops/actions/workflowAuthoringAction';
import { workflowDraftClientRpcMethod } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import {
    currentUiContextCommandClientRpcMethod,
    currentUiContextReadClientRpcMethod,
    mountedWorkReadClientRpcMethod,
    sessionUiActionClientRpcMethod,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import { getMountedWorkReadAddresses, subscribeMountedWorkReadOwners } from '@/sync/ops/actions/mountedWorkReadAction';
import { createCurrentUiContributedActionRpcHandler } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';

function useMachineClientActionBindings({
    serverId, generation, accountId, machineIds, methods, sessionId, readCurrentSessionId, contributedMachineIds,
}: Readonly<{
    serverId: string | null;
    generation: number;
    accountId: string | null;
    machineIds: readonly string[];
    methods: readonly string[];
    sessionId: string | null;
    readCurrentSessionId?: () => string | null;
    contributedMachineIds: ReadonlySet<string>;
}>): void {
    const bindings = React.useRef(new Map<string, Map<string, () => void>>());
    const sessionReader = React.useRef(readCurrentSessionId);
    React.useLayoutEffect(() => { sessionReader.current = readCurrentSessionId; }, [readCurrentSessionId]);
    React.useEffect(() => {
        const registered = bindings.current;
        return () => {
            for (const machine of registered.values()) {
                for (const dispose of machine.values()) dispose();
            }
            registered.clear();
        };
    }, [serverId, generation, accountId]);
    React.useEffect(() => {
        if (!serverId || !accountId) return;
        const nextMachineIds = new Set(machineIds);
        for (const [machineId, registered] of bindings.current) {
            if (nextMachineIds.has(machineId)) continue;
            for (const dispose of registered.values()) dispose();
            bindings.current.delete(machineId);
        }
        const sessionMethod = sessionId ? sessionUiActionClientRpcMethod(sessionId) : null;
        for (const machineId of machineIds) {
            let registered = bindings.current.get(machineId);
            if (!registered) {
                registered = new Map();
                bindings.current.set(machineId, registered);
            }
            const next = new Set([...methods, ...(sessionMethod ? [sessionMethod] : []),
                ...(contributedMachineIds.has(machineId) ? [RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE] : [])]);
            for (const [method, dispose] of registered) {
                if (!next.has(method)) { dispose(); registered.delete(method); }
            }
            for (const method of next) {
                if (registered.has(method)) continue;
                let mounted = true;
                const boundSessionId = method === sessionMethod ? sessionId : null;
                const binding = { serverId, accountId, isCurrent: () => {
                    const active = getActiveServerSnapshot();
                    const state = storage.getState();
                    const machine = resolveServerScopedMachine(state, serverId, machineId);
                    return active.serverId === serverId && active.generation === generation
                        && state.profile?.id === accountId && Boolean(machine
                            && isMachineSelectableForFleet({ serverId, accountId }, machine));
                }, canExecute: () => mounted
                    && (boundSessionId === null || sessionReader.current?.() === boundSessionId) };
                const handler = method === RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE
                    ? createCurrentUiContributedActionRpcHandler({
                        ...binding, machineId, readProjection: readCurrentAppShellPluginUiProjection,
                        execute: async (...args) => {
                            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                            return await createDefaultActionExecutor().execute(...args);
                        },
                    })
                    : createUiClientActionReverseHandler(binding);
                const unregister = apiSocket.registerMachineScopedRpcHandler(machineId, method, handler, { settleInFlight: true });
                registered.set(method, () => { mounted = false; unregister(); });
            }
        }
    }, [serverId, generation, accountId, machineIds, methods, sessionId, contributedMachineIds]);
}

/** Currently reachable Machines share the existing reconnect-safe reverse-RPC channel. */
export function ClientActionReverseRuntime(): null {
    const { serverId, generation } = useActiveServerSnapshot();
    const accountId = storage(state => state.profile?.id ?? null);
    const { selectableMachineIds } = useMachinePresenceMembership(serverId);
    const pluginUiProjection = useAppShellPluginUiDeclarationProjection();
    const contributedMachineIds = new Set(Object.values(pluginUiProjection?.actionsById ?? {}).flatMap(action => {
        const origin = readPluginUiContributionOrigin(action);
        return action.execution.target === 'client' && origin?.phase === 'current' && origin.interactionEnabled
            && origin.serverId === serverId ? [origin.machineId] : [];
    }));
    const addresses = React.useSyncExternalStore(subscribeMountedWorkflowDraftOwners,
        getMountedWorkflowDraftAddresses, getMountedWorkflowDraftAddresses);
    const readAddresses = React.useSyncExternalStore(subscribeMountedWorkReadOwners,
        getMountedWorkReadAddresses, getMountedWorkReadAddresses);
    const currentUiReader = useOptionalCurrentUiContextReader();
    const subscribeCurrentUiRegistration = React.useCallback((listener: () => void) =>
        currentUiReader?.subscribe(listener) ?? (() => {}), [currentUiReader]);
    const readCurrentUiRegistration = React.useCallback(() => {
        const snapshot = currentUiReader?.readCurrentUiContext() ?? null;
        // The reader rebuilds its DTO on every call; only method membership is a stable store snapshot.
        return snapshot ? JSON.stringify([currentUiReader?.readCurrentSessionId?.() ?? null,
            snapshot.commands.map(command => command.id).sort()]) : null;
    }, [currentUiReader]);
    const currentUiRegistration = React.useSyncExternalStore(
        subscribeCurrentUiRegistration,
        readCurrentUiRegistration,
        readCurrentUiRegistration,
    );
    const currentSessionId = currentUiReader?.readCurrentSessionId?.() ?? null;
    const methods = React.useMemo(() => {
        const currentUiSnapshot = currentUiReader?.readCurrentUiContext() ?? null;
        return [...new Set([RPC_METHODS.UI_ACTION_EXECUTE, ...addresses.flatMap(address =>
            address.scope.serverId === serverId && address.scope.accountId === accountId
                ? [workflowDraftClientRpcMethod(address), workflowDraftClientRpcMethod({ scope: address.scope })] : []),
            ...readAddresses.flatMap(address => address.scope.serverId === serverId && address.scope.accountId === accountId
                ? [mountedWorkReadClientRpcMethod(address.actionId, address.sessionId)] : []),
            ...(currentUiSnapshot ? [currentUiContextReadClientRpcMethod(), ...currentUiSnapshot.commands.map(command =>
                currentUiContextCommandClientRpcMethod(command.id))] : []),
        ])];
    }, [serverId, accountId, addresses, readAddresses, currentUiReader, currentUiRegistration]);
    // Registration belongs to the runtime, without one React mount per Machine or method.
    useMachineClientActionBindings({ serverId, generation, accountId, machineIds: selectableMachineIds, methods,
        sessionId: currentSessionId, readCurrentSessionId: currentUiReader?.readCurrentSessionId, contributedMachineIds });
    return null;
}
