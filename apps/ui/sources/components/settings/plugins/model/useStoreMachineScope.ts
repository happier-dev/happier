import * as React from 'react';
import { useMachineAdministrationSelectedTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useDestinationGlobalParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readStoreBrowserProfileRoute, readStoreMachineRoute } from './pluginsSurfaceRoutes';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

const selectMachineParam = (params: Readonly<Record<string, unknown>>) => params.machine;
const selectBrowserProfileParam = (params: Readonly<Record<string, unknown>>) => readStoreBrowserProfileRoute(params);
/** Embedded Store surfaces carry the same Machine scope as a Machine-qualified Store route. */
export const StoreMachineScopeContext = React.createContext<ReturnType<typeof readStoreMachineRoute> | undefined>(undefined);

/** Store routes and embedded installs override the existing Plugins Machine choice; admission stays with Actions. */
export function useStoreMachineScope(includeSelected = true) {
    const inherited = React.useContext(StoreMachineScopeContext);
    const machine = useDestinationGlobalParamsSelector(selectMachineParam);
    const routed = React.useMemo(() => readStoreMachineRoute({ machine }), [machine]);
    const selected = useMachineAdministrationSelectedTarget(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins);
    const chosen = React.useMemo(() => selected ? { serverId: selected.serverIdentityId, machineId: selected.machineId } : null,
        [selected?.serverIdentityId, selected?.machineId]);
    return inherited === undefined ? routed ?? (includeSelected ? chosen : null) : inherited;
}

/** Carry the Store's existing subject scope; the Action owner decides execution placement. */
export function useStoreActionTarget(installMachineId?: string | null, includeSelected = false): ActionExecutorContext['externalActionTarget'] {
    const machine = useStoreMachineScope(includeSelected);
    const machineId = installMachineId ?? machine?.machineId;
    return React.useMemo(() => machineId ? { kind: 'machine', machineId } : undefined, [machineId]);
}

/** The browser profile a profile's Extensions section opened the Store for: the install form's seed, never authority. */
export function useStoreBrowserProfileScope(): string | null {
    return useDestinationGlobalParamsSelector(selectBrowserProfileParam);
}
