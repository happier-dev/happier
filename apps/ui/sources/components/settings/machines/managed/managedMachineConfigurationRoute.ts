import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/** The picker and mounted Machine pages open the same existing draft. */
export function buildManagedMachineConfigurationRoute(input: Readonly<{
    serverId: string;
    provisioner: string;
    controller?: ManagedControllerV1;
    presetOnly?: boolean;
    connectPurpose?: string;
}>): string {
    const params = new URLSearchParams({ serverId: input.serverId });
    if (input.connectPurpose) params.set('connectPurpose', input.connectPurpose);
    if (input.presetOnly) params.set('presetOnly', 'true');
    if (input.controller) {
        params.set('machineId', input.controller.machineId);
        params.set('installationId', input.controller.installationId);
    }
    return `/settings/machines/add/${encodeURIComponent(input.provisioner)}?${params.toString()}`;
}
