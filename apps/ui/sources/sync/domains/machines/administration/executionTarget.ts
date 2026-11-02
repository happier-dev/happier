import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { readLiveMachineInventoryRows, resolvePortableMachineAdministrationTarget } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineReplaced } from '@/sync/domains/machines/identity/machineIdentityTypes';
import { isMachineSelectableForFleet } from './fleetUnion';
import type { FreshMachineAdministrationExecutionTargetV1, MachineAdministrationExecutionTargetOptions } from './useTargetSelection';

/** Fresh invocation admission shared by Administration's selector and non-hook readers. */
export function resolveFreshMachineAdministrationExecutionTarget(
    target: MachineAdministrationTargetV1 | null,
    options: MachineAdministrationExecutionTargetOptions = {},
): FreshMachineAdministrationExecutionTargetV1 | null {
    if (!target) return null;
    const state = storage.getState();
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const machineListByServerId = state.machineListByServerId ?? {};
    const activeMachines = Object.values(state.machines ?? {});
    const resolution = resolvePortableMachineAdministrationTarget({
        target,
        activeServerId: '',
        activeMachines,
        machineListByServerId,
        machineListStatusByServerId: state.machineListStatusByServerId,
    });
    if (resolution.kind !== 'resolved') return null;
    if (!readLiveMachineInventoryRows({
        activeServerId,
        activeMachines,
        machineListByServerId,
        machineListStatusByServerId: state.machineListStatusByServerId ?? {},
        profile: resolution.profile,
        serverIdentityId: resolution.target.serverIdentityId,
    }).has(resolution.machine)) return null;
    const accountScope = 'accountScope' in options ? options.accountScope
        : selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), resolution.profile.id);
    if (!accountScope || !areServerProfileIdentifiersEquivalent(accountScope.serverId, resolution.profile.id)) return null;
    if (resolution.machine.availability?.kind === 'locked'
        || (typeof resolution.machine.revokedAt === 'number' && resolution.machine.revokedAt > 0)
        || isMachineReplaced(resolution.machine)) return null;
    if (options.intent === 'retry') return resolution;
    return isMachineSelectableForFleet(accountScope, resolution.machine) ? resolution : null;
}
