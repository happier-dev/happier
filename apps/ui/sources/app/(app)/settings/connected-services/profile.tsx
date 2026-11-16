import { ConnectedAccountLegacyRouteRedirect } from '@/components/settings/connectedServices/account/ConnectedAccountLegacyRouteRedirect';

export { ConnectedAccountLegacyRouteRedirect as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ConnectedAccountLegacyRouteRedirect} />; }
