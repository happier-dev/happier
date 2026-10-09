import { MachinePresetScreen } from '@/components/settings/machines/managed/MachinePresetView';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

export { MachinePresetScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={MachinePresetScreen} />; }
