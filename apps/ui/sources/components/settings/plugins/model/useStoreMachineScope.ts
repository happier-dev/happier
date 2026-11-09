import * as React from 'react';
import { useDestinationGlobalParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readStoreBrowserProfileRoute, readStoreMachineRoute } from './pluginsSurfaceRoutes';

const selectMachineParam = (params: Readonly<Record<string, unknown>>) => params.machine;
const selectBrowserProfileParam = (params: Readonly<Record<string, unknown>>) => readStoreBrowserProfileRoute(params);

/** The Machine the person chose by entering Store from its page; this is a picker seed, never authority. */
export function useStoreMachineScope() {
    const machine = useDestinationGlobalParamsSelector(selectMachineParam);
    return React.useMemo(() => readStoreMachineRoute({ machine }), [machine]);
}

/** The browser profile a profile's Extensions section opened the Store for: the install form's seed, never authority. */
export function useStoreBrowserProfileScope(): string | null {
    return useDestinationGlobalParamsSelector(selectBrowserProfileParam);
}
