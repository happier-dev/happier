import { PublicProfileSettingsScreen } from '@/components/settings/account/publicProfile/PublicProfileSettingsScreen';

export { PublicProfileSettingsScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PublicProfileSettingsScreen} />; }
