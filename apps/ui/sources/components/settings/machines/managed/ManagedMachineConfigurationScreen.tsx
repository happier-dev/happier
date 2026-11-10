import * as React from 'react';
import { useNavigation } from 'expo-router';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ManagedControllerV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineConfigurationView } from './ManagedMachineConfigurationView';
import { useManagedMachineRouteScope } from './useManagedMachineRouteScope';
import { KnownHomeGate } from '@/components/sessions/access/KnownHomeGate';
import { completeNewSessionPickerReturn, hasNewSessionPickerContinuation } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { useNewSessionPickerReturnHost } from '@/components/sessions/new/navigation/newSessionEntry';
import type { ManagedMachineUse } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';

function first(value: string | string[] | undefined): string { return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''; }
export function ManagedMachineConfigurationScreen() {
    const params = useLocalSearchParams<{ serverId?: string | string[]; provisioner?: string | string[]; presetId?: string | string[];
        presetOnly?: string | string[]; machineId?: string | string[]; installationId?: string | string[]; connectPurpose?: string | string[];
        draftId?: string | string[]; newSessionHostDraftId?: string | string[] }>();
    const navigation = useNavigation();
    const router = useRouter();
    const returnToHost = useNewSessionPickerReturnHost();
    const serverId = useManagedMachineRouteScope(params.serverId);
    const createInComposer = first(params.presetOnly) !== 'true' && hasNewSessionPickerContinuation(params);
    const useInComposer = React.useCallback<ManagedMachineUse>((draft) => {
        completeNewSessionPickerReturn({ navigation, router, currentParams: params,
            routeParams: { machineId: undefined, machinePoolId: undefined, spawnServerId: serverId },
            managedMachineSelection: draft, managedMachineUseOptions: { create: true }, returnToHost });
    }, [navigation, router, params, serverId, returnToHost]);
    const controller = ManagedControllerV1Schema.safeParse({ machineId: first(params.machineId), installationId: first(params.installationId) });
    return <KnownHomeGate serverId={serverId} testIDPrefix="managed-route">
        <ManagedMachineConfigurationView serverId={serverId} provisioner={first(params.provisioner)} presetId={first(params.presetId) || undefined}
            presetOnly={first(params.presetOnly) === 'true'} initialController={controller.success ? controller.data : undefined}
            initialConnectPurpose={first(params.connectPurpose) || undefined}
            createOnUse={createInComposer} onUse={createInComposer ? useInComposer : undefined} />
    </KnownHomeGate>;
}
