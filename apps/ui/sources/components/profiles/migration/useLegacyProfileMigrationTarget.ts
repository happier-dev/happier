import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { listProviderSettingsTargetMachines, resolveProviderSettingsTargetMachine } from '@/providers/hooks/targetMachine';
import { useAllMachines, useMachineListByServerId } from '@/sync/domains/state/storage';

export function useLegacyProfileMigrationTarget() {
    const machines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const activeServer = useActiveServerSnapshot();
    const serverId = typeof activeServer.serverId === 'string' ? activeServer.serverId : null;
    const [preferredMachineId, setPreferredMachineId] = React.useState<string | null>(null);
    const targetMachines = React.useMemo(() => listProviderSettingsTargetMachines({
        serverId,
        machines,
        machineListByServerId,
    }), [machineListByServerId, machines, serverId]);
    const machineId = React.useMemo(() => resolveProviderSettingsTargetMachine({
        serverId,
        preferredMachineId,
        machines,
        machineListByServerId,
    }), [machineListByServerId, machines, preferredMachineId, serverId]);

    return { machineId, serverId, targetMachines, setPreferredMachineId } as const;
}
