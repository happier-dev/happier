import { ManagedMachineDetailScreen as WorkspaceRouteBody } from '@/components/settings/machines/managed/ManagedMachineDetail';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
