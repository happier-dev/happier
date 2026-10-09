import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readMachineReferenceCensusV1, type MachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import type { ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { readProfileCatalogInContext } from '@/sync/api/account/apiProfileCatalog';
import { listAutomationDefinitions } from '@/sync/api/automations/apiAutomations';
import { createManagedMachineActionClient } from '@/sync/api/machines/managedMachineActions';
import { createMachinePoolActionClient } from '@/sync/api/machines/machinePoolActions';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Requester-owned disclosure. Native controllers never supply another Account's private references. */
export function createUiManagedMachineReferenceReader(account: LazyActionAccountContext): NonNullable<ActionExecutorDeps['managedMachineReferences']> {
    return async ({ input, signal }) => {
        account.assertCurrent();
        const unavailable = (reason: MachineReferenceCensusV1['unavailable'][number]): MachineReferenceCensusV1 => ({
            homeId: input.homeId, machineId: null, coverage: 'partial', references: [], unavailable: [reason],
        });
        if (!account.serverIdentityId || input.homeId !== account.serverIdentityId) return unavailable('target');
        let machine: ManagedMachineActionOutputV1<'machines.managed.get'>;
        try {
            machine = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get', input, { signal });
        } catch {
            account.assertCurrent();
            signal?.throwIfAborted();
            return unavailable('target');
        }
        account.assertCurrent();
        if (machine.homeId !== input.homeId || machine.id !== input.managedId) return unavailable('target');
        const census = await readMachineReferenceCensusV1({ homeId: input.homeId,
            machineId: machine.enrolledMachineId ?? null, homeAliases: [account.serverId], signal }, {
            artifacts: account.workflowArtifacts,
            readSettings: account.readRawSettings,
            readProfileCatalog: () => readProfileCatalogInContext(account, signal, { readSourceBaseline: true }),
            readPools: () => createMachinePoolActionClient({ request: account.request }).execute('machines.pools.list', {}, {
                serverId: account.serverId, signal,
            }),
            readAssignments: cursor => listAutomationDefinitions(account.credentials, cursor ? { cursor } : {}, account),
        });
        account.assertCurrent();
        return census;
    };
}
