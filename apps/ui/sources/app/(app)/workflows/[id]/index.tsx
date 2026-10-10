import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { WorkflowEditorRoute } from '@/components/workflows/screens/WorkflowEditorRoute';

export { WorkflowEditorRoute as NewWorkflowRoute, WorkflowEditorRoute as SavedWorkflowRoute, WorkflowEditorRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkflowEditorRoute} />; }
