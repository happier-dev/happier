import * as React from 'react';
import { useDestinationGlobalParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readStoreMachineRoute } from './pluginsSurfaceRoutes';

const selectMachineParam = (params: Readonly<Record<string, unknown>>) => params.machine;

/** The Machine the person chose by entering Store from its page; this is a picker seed, never authority. */
export function useStoreMachineScope() {
    const machine = useDestinationGlobalParamsSelector(selectMachineParam);
    return React.useMemo(() => readStoreMachineRoute({ machine }), [machine]);
}
