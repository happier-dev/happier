import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import type { ProjectSourceAddressMachines } from './projectSourcesController';

/** Reads only the containing Home's inventory and incumbent SCM Machine preference. */
export function readProjectSourceAddressMachines(serverId: string): ProjectSourceAddressMachines {
    const state = storage.getState();
    const machines = resolveServerScopedMachines({ serverId, activeServerId: getActiveServerSnapshot().serverId,
        activeMachines: state.isDataReady ? Object.values(state.machines) : [],
        machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId,
    }) ?? [];
    const selected = resolveFreshMachineAdministrationExecutionTarget(
        state.settings.machineAdministrationTargetsLocalV1[MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl] ?? null);
    return { machines, preferredMachineId: selected && areServerProfileIdentifiersEquivalent(selected.serverId, serverId) ? selected.machine.id : null };
}
