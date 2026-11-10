import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { NewAppScreen } from '@/components/projects/starters/NewAppScreen';

export { NewAppScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewAppScreen} />; }
