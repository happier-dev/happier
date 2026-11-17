import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { WorkflowsEventDetail } from '@/components/workflows/events/WorkflowsEventsDestination';

export { WorkflowsEventDetail as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkflowsEventDetail} />; }
