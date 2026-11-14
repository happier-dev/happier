import { MachineFleetActivityView as WorkspaceRouteBody } from '@/components/machines/activity/MachineFleetActivityView';
export { WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
