import * as React from 'react';
import { readMachineActivity, subscribeMachineActivity, type MachineActivityFacts } from '@/sync/domains/machines/machineActivity';

/** Only a leaf which actually displays this Machine's timestamp reads its clock. */
export function useMachineActivity(machine: MachineActivityFacts | null | undefined): MachineActivityFacts | null {
    const subscribe = React.useCallback((listener: () => void) => machine
        ? subscribeMachineActivity(machine, listener) : () => {}, [machine]);
    const read = React.useCallback(() => machine ? readMachineActivity(machine) : null, [machine]);
    return React.useSyncExternalStore(subscribe, read, read);
}

