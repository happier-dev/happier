import { DevcontainerChildProjectionV1Schema } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import type { WorkspaceSyncChildMachineFacts, WorkspaceSyncChildMachineProjection } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { fetchMachineRows } from '@/sync/engine/machines/syncMachines';
import { createManagedMachineActionClient } from '@/sync/api/machines/managedMachineActions';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actions/actionAccountContext';

/** One admitted Machine census, with each demanded child's retained facts shared
 * by its projections. A later census always reads fresh facts. */
export async function readUiWorkspaceSyncChildMachineFacts(account: LazyActionAccountContext, signal?: AbortSignal): Promise<Readonly<{
    childMachineProjections: readonly WorkspaceSyncChildMachineProjection[];
    readChildMachines(machineIds: readonly string[]): Promise<readonly WorkspaceSyncChildMachineFacts[]>;
}>> {
    account.assertCurrent();
    const machines = await withActionAccountRequestSignal(account, signal, ownedSignal => fetchMachineRows({ credentials: account.credentials,
        readTransport: account.readTransport, signal: ownedSignal,
        request: (path, init) => account.request(path, { ...init, signal: ownedSignal }) }));
    account.assertCurrent();
    const childMachineProjections = machines.flatMap(machine => machine.devcontainerChild
        ? [{ serverId: account.serverId, machineId: machine.id, projection: DevcontainerChildProjectionV1Schema.parse(machine.devcontainerChild) }] : []);
    const managed = createManagedMachineActionClient({ request: account.request });
    const childFacts = new Map<string, Promise<WorkspaceSyncChildMachineFacts>>();
    return {
        childMachineProjections,
        async readChildMachines(machineIds: readonly string[]): Promise<readonly WorkspaceSyncChildMachineFacts[]> {
            const facts: WorkspaceSyncChildMachineFacts[] = [];
            for (const machineId of new Set(machineIds)) {
                account.assertCurrent();
                signal?.throwIfAborted();
                const machine = machines.find(candidate => candidate.id === machineId);
                if (!machine || machine.revokedAt != null || machine.replacedByMachineId
                    || machine.access && machine.access.accessState !== 'ready') throw new Error('Current Machine is unavailable');
                const child = childMachineProjections.find(candidate => candidate.machineId === machineId);
                if (!child) continue;
                const installationId = machine.installationId;
                if (!installationId) throw new Error('Child installation is unavailable');
                let pending = childFacts.get(machineId);
                if (!pending) {
                    pending = (async () => {
                        const managedMachine = await managed.execute('machines.managed.get', {
                            homeId: account.serverId, managedId: child.projection.relation.managedMachineId,
                        }, { signal });
                        if (!managedMachine.controller) throw new Error('Child controller is unavailable');
                        return { ...child, installationId, managedMachine,
                            controller: { ...managedMachine.controller, available: false } };
                    })();
                    // Retain failures too: this census cannot retry the same read per
                    // declaration. The next real observation owns its fresh attempt.
                    childFacts.set(machineId, pending);
                }
                const fact = await pending;
                account.assertCurrent();
                signal?.throwIfAborted();
                facts.push(fact);
            }
            return facts;
        },
    };
}
