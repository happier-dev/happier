import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { ProjectOpenScreen } from '@/components/projects/activation/ProjectOpenScreen';

export { ProjectOpenScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ProjectOpenScreen} />; }
