import { RetiredAutomationRoute } from '@/components/automations/screens/RetiredAutomationRoute';

export function AutomationEditRoute() {
    return <RetiredAutomationRoute />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { AutomationEditRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={AutomationEditRoute} />; }
