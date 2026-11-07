import type { AcpCatalogRecordV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { readInstalledMachineAgentInventory } from '@/sync/domains/capabilities/reach/installedMachineAgents';
import type { InstalledAgentRow } from './storeInstalled';

/** One native Agent subject, with its recorded memberships; observation carriers never become row content. */
export function createInstalledAgentRowsProjection(scope: ServerAccountScope | null) {
    let previous: readonly InstalledAgentRow[] = [];
    return (definitions: readonly AcpCatalogRecordV1['definitions'][number][],
        machines: readonly Readonly<{ id: string }>[], inventory: readonly ReturnType<typeof readInstalledMachineAgentInventory>[]) => {
        if (!scope) return previous;
        const byKey = new Map(previous.map(row => [row.key, row]));
        const next: InstalledAgentRow[] = definitions.map(native => {
            const key = serverAccountScopedResourceKey(scope, 'agent', 'definition', native.id);
            const retained = byKey.get(key);
            return retained?.subject === 'definition' && retained.native === native ? retained
                : { kind: 'agent', subject: 'definition', key, scope, native };
        });
        const memberships = new Map<string, string[]>();
        machines.forEach((machine, index) => {
            for (const agentId of inventory[index]!.agentIds) {
                const members = memberships.get(agentId);
                if (members) members.push(machine.id); else memberships.set(agentId, [machine.id]);
            }
        });
        for (const [native, machineIds] of memberships) {
            const key = serverAccountScopedResourceKey(scope, 'agent', 'machineAgent', native);
            const retained = byKey.get(key);
            next.push(retained?.subject === 'machineAgent' && retained.machineIds.length === machineIds.length
                && retained.machineIds.every((id, index) => id === machineIds[index]) ? retained
                : { kind: 'agent', subject: 'machineAgent', key, scope, native, machineIds });
        }
        if (next.length !== previous.length || next.some((row, index) => row !== previous[index])) previous = next;
        return previous;
    };
}
