import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { ManagedControllerV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineConfigurationView } from './ManagedMachineConfigurationView';

function first(value: string | string[] | undefined): string { return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''; }
export function ManagedMachineConfigurationScreen() {
    const params = useLocalSearchParams<{ serverId?: string | string[]; provisioner?: string | string[]; presetId?: string | string[];
        presetOnly?: string | string[]; machineId?: string | string[]; installationId?: string | string[] }>();
    const controller = ManagedControllerV1Schema.safeParse({ machineId: first(params.machineId), installationId: first(params.installationId) });
    return <ManagedMachineConfigurationView serverId={first(params.serverId)} provisioner={first(params.provisioner)} presetId={first(params.presetId) || undefined}
        presetOnly={first(params.presetOnly) === 'true'} initialController={controller.success ? controller.data : undefined} />;
}
