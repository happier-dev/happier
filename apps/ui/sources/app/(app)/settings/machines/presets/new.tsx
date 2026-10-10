import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { MachineProvisionerPicker } from '@/components/settings/machines/managed/MachineProvisionerPicker';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { t } from '@/text';

export function NewMachinePresetRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[] }>();
    const serverId = (Array.isArray(params.serverId) ? params.serverId[0] : params.serverId)?.trim() ?? '';
    return <ItemList>
        <SettingsPageHeader description={t('machinePresets.empty')} />
        <MachineProvisionerPicker serverId={serverId} presetOnly />
    </ItemList>;
}
export { NewMachinePresetRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewMachinePresetRoute} />; }
