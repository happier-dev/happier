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
import { sessionUiActionClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { createCurrentUiContributedActionRpcHandler } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { getDesktopAppWindowMountedSurfaces, subscribeDesktopAppWindowMountedSurfaces } from '@/desktop/window/appWindowSurface';
import { useMountedClientActionMethods } from './mountedClientActionAddresses';

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
                    && (boundSessionId === null || sessionReader.current?.() === boundSessionId
                        || getDesktopAppWindowMountedSurfaces().some(surface => surface.homeId === serverId
                            && surface.accountId === accountId && surface.methods?.includes(method))) };
                const handler = method === RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE
                    ? createCurrentUiContributedActionRpcHandler({
                        ...binding, machineId, readProjection: readCurrentAppShellPluginUiProjection,
                        execute: async (...args) => {
                            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                            return await createDefaultActionExecutor().execute(...args);
                        },
                    })
                    : createUiClientActionReverseHandler({ ...binding, machineId });
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
    const localMethods = useMountedClientActionMethods(serverId, accountId);
    const windowSurfaces = React.useSyncExternalStore(subscribeDesktopAppWindowMountedSurfaces,
        getDesktopAppWindowMountedSurfaces, getDesktopAppWindowMountedSurfaces);
    const currentUiReader = useOptionalCurrentUiContextReader();
    const currentSessionId = currentUiReader?.readCurrentSessionId?.() ?? null;
    const methods = React.useMemo(() => [...new Set([RPC_METHODS.UI_ACTION_EXECUTE, ...localMethods,
        ...windowSurfaces.flatMap(surface => surface.homeId === serverId && surface.accountId === accountId
            ? surface.methods ?? [] : []),
    ])], [serverId, accountId, localMethods, windowSurfaces]);
    // Registration belongs to the runtime, without one React mount per Machine or method.
    useMachineClientActionBindings({ serverId, generation, accountId, machineIds: selectableMachineIds, methods,
        sessionId: currentSessionId, readCurrentSessionId: currentUiReader?.readCurrentSessionId, contributedMachineIds });
    return null;
}
