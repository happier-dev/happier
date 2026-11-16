import { UpdatesView } from '@/components/updates/UpdatesView';

export { UpdatesView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={UpdatesView} />; }
