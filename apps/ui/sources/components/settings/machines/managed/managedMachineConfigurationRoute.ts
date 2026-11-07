import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/** The picker, presets and mounted Machine pages open the same existing draft; a preset prefills it. */
export function buildManagedMachineConfigurationRoute(input: Readonly<{
    serverId: string;
    provisioner: string;
    controller?: ManagedControllerV1;
    presetId?: string;
    presetOnly?: boolean;
    connectPurpose?: string;
}>): string {
    const params = new URLSearchParams({ serverId: input.serverId });
    if (input.presetId) params.set('presetId', input.presetId);
    if (input.connectPurpose) params.set('connectPurpose', input.connectPurpose);
    if (input.presetOnly) params.set('presetOnly', 'true');
    if (input.controller) {
        params.set('machineId', input.controller.machineId);
        params.set('installationId', input.controller.installationId);
    }
    return `/settings/machines/add/${encodeURIComponent(input.provisioner)}?${params.toString()}`;
}
