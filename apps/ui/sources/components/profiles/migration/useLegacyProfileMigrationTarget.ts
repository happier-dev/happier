import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useMachineListByServerId } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';

/**
 * Machines the legacy Profile migration may target on the active server. This
 * flow makes an ephemeral, unpersisted choice for a single migration run, so it
 * owns its own eligibility rather than borrowing another domain's selection.
 */
function listLegacyProfileMigrationMachines(input: Readonly<{
    serverId: string | null;
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
}>): readonly Machine[] {
    if (!input.serverId) return [];
    const explicit = input.machineListByServerId[input.serverId];
    return Array.isArray(explicit)
        ? explicit.filter((machine) => machine.revokedAt == null)
        : [];
}

export function useLegacyProfileMigrationTarget() {
    const machineListByServerId = useMachineListByServerId();
    const activeServer = useActiveServerSnapshot();
    const serverId = typeof activeServer.serverId === 'string' ? activeServer.serverId : null;
    const [preferredMachineId, setPreferredMachineId] = React.useState<string | null>(null);
    const targetMachines = React.useMemo(() => listLegacyProfileMigrationMachines({
        serverId,
        machineListByServerId,
    }), [machineListByServerId, serverId]);
    const machineId = React.useMemo(() => {
        if (preferredMachineId && targetMachines.some((machine) => machine.id === preferredMachineId)) {
            return preferredMachineId;
        }
        return targetMachines.find((machine) => machine.active === true)?.id
            ?? targetMachines[0]?.id
            ?? null;
    }, [preferredMachineId, targetMachines]);

    return { machineId, serverId, targetMachines, setPreferredMachineId } as const;
}
