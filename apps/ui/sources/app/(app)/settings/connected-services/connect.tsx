import { ConnectedServiceSetupPage } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupPage';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

export const WorkspaceRouteBody = ConnectedServiceSetupPage;
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
