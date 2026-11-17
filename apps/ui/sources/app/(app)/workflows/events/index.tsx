import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { WorkflowsEventsIndex } from '@/components/workflows/events/WorkflowsEventsDestination';

export { WorkflowsEventsIndex as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkflowsEventsIndex} />; }
