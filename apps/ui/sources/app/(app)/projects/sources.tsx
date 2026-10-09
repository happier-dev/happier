import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { ProjectSourcesScreen } from '@/components/projects/sources/ProjectSourcesScreen';

export { ProjectSourcesScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ProjectSourcesScreen} />; }
