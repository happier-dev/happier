import { ProfileDefaultEnvironmentScreen } from '@/components/settings/profiles/ProfileDefaultEnvironmentScreen';

export { ProfileDefaultEnvironmentScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ProfileDefaultEnvironmentScreen} />; }
