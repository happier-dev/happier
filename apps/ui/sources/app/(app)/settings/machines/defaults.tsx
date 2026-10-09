import { MachineDefaultsView as WorkspaceRouteBody } from '@/components/settings/machines/managed/MachineDefaultsView';
export { WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
