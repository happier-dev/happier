import {
    captureMachinePresenceObservation,
    type MachineReachabilityScope,
} from '@/sync/domains/machines/reachability/machineReachability';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { publishMachineActivities, type MachineActivityFacts } from '@/sync/domains/machines/machineActivity';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

/** A fresh fixture ingress after publishing its rows; reconnect alone is not an observation. */
export function observeMachinePresenceForTest(scope: MachineReachabilityScope, machineIds: readonly string[]): void {
    captureMachinePresenceObservation(scope)(machineIds);
}

/** Answer activity on supplied rows when a test separately controls hydration projections. */
export function publishMachineActivityForTest(machines: readonly Machine[], activity?: MachineActivityFacts): void {
    publishMachineActivities(machines.map(machine => ({ machine, activity: activity ?? machine, projections: [] })));
}

/** Publish the addressed Home inventory before observing its fresh presence ingress. */
export async function publishMachineInventoryForTest(scope: MachineReachabilityScope, machines: readonly Machine[]): Promise<void> {
    // Call after installing Home boundaries; importing this helper must not load Sync.
    const { storage } = await import('@/sync/domains/state/storageStore');
    if (areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, scope.serverId)) {
        storage.setState({ profileScope: { ...scope, serverId: resolveServerProfileScopeIdForIdentifier(scope.serverId) } });
    }
    storage.getState().applyMachines([...machines], true, {
        sourceServerId: scope.serverId,
        sourceAccountId: scope.accountId,
    });
    storage.getState().markMachineListSettled(scope.serverId);
    observeMachinePresenceForTest(scope, machines.map(machine => machine.id));
}
