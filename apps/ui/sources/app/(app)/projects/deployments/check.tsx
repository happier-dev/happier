import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { ServiceCheckPage } from '@/components/projects/deployments/ServiceCheckPage';

export { ServiceCheckPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ServiceCheckPage} />; }
