import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { SavedMachineServiceHealthResult } from './savedHealthChecks';

type ServiceHealthOwner = Pick<ReturnType<typeof createManagedServicesOwner>,
    'listMachineServices' | 'listProjectServices' | 'machineServiceRows'>;

/** Publish through the same retained service owner used by Machine reads. */
export async function publishSavedServiceHealthResult(owner: ServiceHealthOwner, value: SavedMachineServiceHealthResult): Promise<void> {
    const handles = [...owner.listMachineServices(), ...owner.listProjectServices()];
    for (const handle of handles) {
        const target = handle.kind === 'workspace' ? handle.workspace : handle;
        if (target.machineId !== value.subject.machineId || handle.serviceId !== value.subject.serviceId
            || handle.instanceId !== value.generation) continue;
        // Saved checks use the local profile; adopted service handles use the portable Home id.
        if (!await isServerProfileHomeIdentity(value.serverId, target.serverId)) continue;
        owner.machineServiceRows.publishHealthResult(handle, { ...value, serverId: target.serverId });
        return;
    }
}
