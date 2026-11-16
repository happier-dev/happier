import { AccountSecuritySettingsScreen } from '@/components/settings/account/AccountSecuritySettingsScreen';

export { AccountSecuritySettingsScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={AccountSecuritySettingsScreen} />; }
