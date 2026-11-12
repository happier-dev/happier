import * as React from 'react';
import { useMachineAdministrationSelectedTarget, useMachineAdministrationTargetSelection, type MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useDestinationGlobalParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readStoreBrowserProfileRoute, readStoreMachineRoute } from './pluginsSurfaceRoutes';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const selectMachineParam = (params: Readonly<Record<string, unknown>>) => params.machine;
const selectBrowserProfileParam = (params: Readonly<Record<string, unknown>>) => readStoreBrowserProfileRoute(params);
/** Embedded Store surfaces carry the same Machine scope as a Machine-qualified Store route. */
export const StoreMachineScopeContext = React.createContext<ReturnType<typeof readStoreMachineRoute> | undefined>(undefined);
const StoreSelectedMachineScopeContext = React.createContext<ReturnType<typeof readStoreMachineRoute> | undefined>(undefined);
export const StoreMachineSelectionContext = React.createContext<Readonly<{
    selection: MachineAdministrationTargetSelectionV1;
    pickerOpen: boolean;
    setPickerOpen: (open: boolean) => void;
}> | null>(null);

/** One Store selection uses the existing Plugins choice, including its sole-online-Machine initialization. */
export function StoreMachineSelectionProvider(props: Readonly<{ presented: boolean; accountScope: ServerAccountScope | null; children: React.ReactNode }>) {
    const explicit = useStoreMachineScope(false);
    const initialTarget = React.useMemo(() => explicit ? { serverIdentityId: explicit.serverId, machineId: explicit.machineId } : undefined,
        [explicit?.serverId, explicit?.machineId]);
    const selection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins, {
        enabled: props.presented && props.accountScope !== null,
        ...(props.accountScope ? { accountScope: props.accountScope } : {}),
        ...(initialTarget ? { initialTarget } : {}),
    });
    const target = selection.selectedTarget ?? (selection.state.kind === 'online' ? selection.state.target : null);
    const scope = React.useMemo(() => target ? { serverId: target.serverIdentityId, machineId: target.machineId } : null,
        [target?.serverIdentityId, target?.machineId]);
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const value = React.useMemo(() => ({ selection, pickerOpen, setPickerOpen }), [selection, pickerOpen]);
    // Registry readers consume only identity changes, rather than the picker's inventory and disclosure state.
    return React.createElement(StoreSelectedMachineScopeContext.Provider, { value: scope },
        React.createElement(StoreMachineSelectionContext.Provider, { value }, props.children));
}

/** Store routes and embedded installs override the existing Plugins Machine choice; admission stays with Actions. */
export function useStoreMachineScope(includeSelected = true) {
    const inherited = React.useContext(StoreMachineScopeContext);
    const storeSelected = React.useContext(StoreSelectedMachineScopeContext);
    const machine = useDestinationGlobalParamsSelector(selectMachineParam);
    const routed = React.useMemo(() => readStoreMachineRoute({ machine }), [machine]);
    const selected = useMachineAdministrationSelectedTarget(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins);
    const chosen = React.useMemo(() => selected ? { serverId: selected.serverIdentityId, machineId: selected.machineId } : null,
        [selected?.serverIdentityId, selected?.machineId]);
    if (inherited !== undefined) return inherited;
    if (includeSelected && storeSelected !== undefined) return storeSelected;
    return routed ?? (includeSelected ? chosen : null);
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
