import * as React from 'react';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage, useAllMachines } from '@/sync/domains/state/storage';
import { createUiClientActionReverseHandler } from '@/sync/ops/actions/clientActionReverseDispatch';

/** Account-visible Machines share the existing reconnect-safe reverse-RPC channel. */
export function ClientActionReverseRuntime(): null {
    const { serverId, generation } = useActiveServerSnapshot();
    const accountId = storage(state => state.profile?.id ?? null);
    const machines = useAllMachines();
    // Machine metadata updates need not retire an otherwise identical delivery binding.
    const machineIds = JSON.stringify(machines.map(machine => machine.id).sort());
    React.useEffect(() => {
        if (!serverId || !accountId) return;
        let mounted = true;
        const handler = createUiClientActionReverseHandler({ serverId, accountId, isCurrent: () => {
            const active = getActiveServerSnapshot();
            return mounted && active.serverId === serverId && active.generation === generation
                && storage.getState().profile?.id === accountId;
        } });
        const ids: string[] = JSON.parse(machineIds);
        const disposers = ids.map(machineId => apiSocket.registerMachineScopedRpcHandler(
            machineId, RPC_METHODS.UI_ACTION_EXECUTE, handler,
        ));
        return () => {
            mounted = false;
            for (const dispose of disposers) dispose();
        };
    }, [serverId, generation, accountId, machineIds]);
    return null;
}
