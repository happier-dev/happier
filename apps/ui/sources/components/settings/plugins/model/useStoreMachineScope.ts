import * as React from 'react';
import { useDestinationGlobalParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readStoreBrowserProfileRoute, readStoreMachineRoute } from './pluginsSurfaceRoutes';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

const selectMachineParam = (params: Readonly<Record<string, unknown>>) => params.machine;
const selectBrowserProfileParam = (params: Readonly<Record<string, unknown>>) => readStoreBrowserProfileRoute(params);
/** Embedded Store surfaces carry the same Machine scope as a Machine-qualified Store route. */
export const StoreMachineScopeContext = React.createContext<ReturnType<typeof readStoreMachineRoute> | undefined>(undefined);

/** The Machine the person chose by entering Store from its page; this is a picker seed, never authority. */
export function useStoreMachineScope() {
    const inherited = React.useContext(StoreMachineScopeContext);
    const machine = useDestinationGlobalParamsSelector(selectMachineParam);
    const routed = React.useMemo(() => readStoreMachineRoute({ machine }), [machine]);
    return inherited === undefined ? routed : inherited;
}

/** Carry the Store's existing subject scope; the Action owner decides execution placement. */
export function useStoreActionTarget(): ActionExecutorContext['externalActionTarget'] {
    const machine = useStoreMachineScope();
    return React.useMemo(() => machine ? { kind: 'machine', machineId: machine.machineId } : undefined, [machine?.machineId]);
}

/** The browser profile a profile's Extensions section opened the Store for: the install form's seed, never authority. */
export function useStoreBrowserProfileScope(): string | null {
    return useDestinationGlobalParamsSelector(selectBrowserProfileParam);
}
