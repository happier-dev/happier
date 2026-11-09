import { DeploymentsSettingsView } from '@/components/settings/deployments/DeploymentsSettingsView';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

export const WorkspaceRouteBody = DeploymentsSettingsView;
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
