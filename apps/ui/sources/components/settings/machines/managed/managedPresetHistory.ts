import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { machineCollectionHref } from '../collection/machineCollectionModel';
import { describeManagedCreation } from './managedCreationPresentation';

export type ManagedPresetHistoryRow = Readonly<{
    managedId: string;
    presetRevision: number;
    title: string;
    subtitle: string;
    href: string;
    machine: ManagedMachineV1;
}>;

/** History is a projection of admitted resource rows, including archived and recovery rows. */
export function buildManagedPresetHistory(input: Readonly<{
    serverId: string;
    homeId: string;
    presetId: string;
    machines: readonly ManagedMachineV1[];
}>): readonly ManagedPresetHistoryRow[] {
    return input.machines.flatMap(machine => {
        if (machine.homeId !== input.homeId || machine.preset?.id !== input.presetId) return [];
        return [{ managedId: machine.id, presetRevision: machine.preset.revision,
            title: machine.launch.name, subtitle: describeManagedCreation(machine).line,
            href: machineCollectionHref({ kind: 'managed', managedId: machine.id, serverId: input.serverId,
                ...(machine.enrolledMachineId ? { enrolledMachineId: machine.enrolledMachineId } : {}) }), machine }];
    });
}
