import { ConnectedServiceConnectRoute } from '@/components/settings/connectedServices/setup/ConnectedServiceConnectRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

export const WorkspaceRouteBody = ConnectedServiceConnectRoute;
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
