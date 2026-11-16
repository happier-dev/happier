import { ManagedMachineConfigurationScreen } from '@/components/settings/machines/managed/ManagedMachineConfigurationScreen';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

export { ManagedMachineConfigurationScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ManagedMachineConfigurationScreen} />; }
