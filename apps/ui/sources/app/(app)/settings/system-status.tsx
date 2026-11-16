import { SystemStatusView } from '@/components/settings/systemStatus/SystemStatusView';

export { SystemStatusView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SystemStatusView} />; }
