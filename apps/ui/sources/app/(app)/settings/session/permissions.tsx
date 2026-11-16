import { PermissionsSettingsView } from '@/components/settings/session/PermissionsSettingsView';

export { PermissionsSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PermissionsSettingsView} />; }
