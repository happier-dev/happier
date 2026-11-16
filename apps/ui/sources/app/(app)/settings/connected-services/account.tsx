import { ConnectedAccountServiceView } from '@/components/settings/connectedServices/account/ConnectedAccountServiceView';

export { ConnectedAccountServiceView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ConnectedAccountServiceView} />; }
