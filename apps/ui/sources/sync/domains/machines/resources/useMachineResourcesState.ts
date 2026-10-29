import * as React from 'react';

import { machineResourcesStore, readMachineResourcesEntry, type MachineResourcesStateEntry } from './machineResourcesStore';

export function useMachineResourcesState(machineId: string): MachineResourcesStateEntry {
    return React.useSyncExternalStore(
        machineResourcesStore.subscribe,
        () => readMachineResourcesEntry(machineId),
        () => readMachineResourcesEntry(machineId),
    );
}
