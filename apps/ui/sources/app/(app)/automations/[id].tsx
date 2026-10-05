import { RetiredAutomationRoute } from '@/components/automations/screens/RetiredAutomationRoute';

export function AutomationDetailRoute() {
    return <RetiredAutomationRoute />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { AutomationDetailRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={AutomationDetailRoute} />; }
