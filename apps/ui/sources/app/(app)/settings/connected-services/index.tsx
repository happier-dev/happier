import { ConnectedServicesSettingsView } from '@/components/settings/connectedServices/ConnectedServicesSettingsView';

export { ConnectedServicesSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ConnectedServicesSettingsView} />; }
