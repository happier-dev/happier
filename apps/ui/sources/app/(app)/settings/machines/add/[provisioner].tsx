import { ManagedMachineConfigurationScreen } from '@/components/settings/machines/managed/ManagedMachineConfigurationScreen';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

export const WorkspaceRouteBody = ManagedMachineConfigurationScreen;
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
