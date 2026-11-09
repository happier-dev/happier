import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { AllDeploymentsScreen } from '@/components/projects/deployments/AllDeploymentsScreen';

export { AllDeploymentsScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={AllDeploymentsScreen} />; }
