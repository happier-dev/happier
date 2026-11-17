import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { ProjectSourcesScreen } from '@/components/projects/sources/ProjectSourcesScreen';

/** Public Source setup landing; its consumer owns exact-Home authentication before reading. */
function ProjectSourceSetupBody() { return <ProjectSourcesScreen setupLink />; }

export { ProjectSourceSetupBody as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ProjectSourceSetupBody} />; }
