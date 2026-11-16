import { DeploymentsSettingsView } from '@/components/settings/deployments/DeploymentsSettingsView';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

export { DeploymentsSettingsView as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={DeploymentsSettingsView} />; }
