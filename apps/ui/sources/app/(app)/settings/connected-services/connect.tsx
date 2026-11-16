import { ConnectedServiceConnectRoute } from '@/components/settings/connectedServices/setup/ConnectedServiceConnectRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

export { ConnectedServiceConnectRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ConnectedServiceConnectRoute} />; }
