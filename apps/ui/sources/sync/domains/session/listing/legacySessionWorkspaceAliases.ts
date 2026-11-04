import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { machineCollectionValues, type MachineCollection } from '@/sync/domains/machines/identity/machineCollection';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { normalizeSessionPathForProjectGrouping } from './sessionListProjectGroupingKeys';
import { buildSessionWorkspaceFallbackOrderKey as buildPredecessorWorkspaceKey } from './sessionWorkspaceOrderKeys';

export type LegacyWorkspaceAliasMachine = Pick<MachineDisplayRenderable,
    'id' | 'metadata' | 'replacedByMachineId' | 'replacedAt'>;

/** Serialization ingress for the actual 0.2 workspace keys, never a Project identity decision. */
export function buildLegacySessionWorkspaceAliasIndex(
    refs: readonly WorkspaceRefV1[],
    censusServerId: string,
    machines: MachineCollection<LegacyWorkspaceAliasMachine> | undefined,
): ReadonlyMap<string, WorkspaceRefV1 | null> {
    const result = new Map<string, WorkspaceRefV1 | null>();
    if (!censusServerId || !machines) return result;
    // Array inputs are indexed once, not scanned for every checkout/replacement hop.
    const machinesById = new Map(machineCollectionValues(machines).map(machine => [machine.id, machine]));
    const context = workspaceRefResolutionContextV1();
    const home = context.normalizeServerId(censusServerId);
    const canonicalMachineIds = new Map<string, string | null>();
    for (const ref of refs) {
        if (context.normalizeServerId(ref.serverId) !== home) continue;
        const machine = machinesById.get(ref.machineId);
        if (!machine) continue;
        if (!canonicalMachineIds.has(ref.machineId)) {
            const resolved = resolveCanonicalMachineId(ref.machineId, machinesById);
            canonicalMachineIds.set(ref.machineId, resolved && resolved.reason !== 'missingReplacementTarget' ? resolved.machineId : null);
        }
        const machineId = canonicalMachineIds.get(ref.machineId);
        if (!machineId) continue;
        const path = normalizeSessionPathForProjectGrouping(ref.rootPath, machinesById.get(machineId)?.metadata?.homeDir);
        const key = buildPredecessorWorkspaceKey([home, machineId, path]);
        // A legacy hash cannot disambiguate collisions, including distinct checkout ids.
        const previous = result.get(key);
        result.set(key, previous === undefined || previous?.id === ref.id && previous.serverId === ref.serverId ? ref : null);
    }
    return result;
}
