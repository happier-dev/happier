import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { MachineProvisionerPicker } from '@/components/settings/machines/managed/MachineProvisionerPicker';

export function NewMachinePresetRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[] }>();
    const serverId = (Array.isArray(params.serverId) ? params.serverId[0] : params.serverId)?.trim() ?? '';
    return <MachineProvisionerPicker serverId={serverId} presetOnly />;
}
export { NewMachinePresetRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewMachinePresetRoute} />; }
