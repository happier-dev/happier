import { MachineSummaryAppearanceScreen as WorkspaceRouteBody } from '@/components/settings/appearance/AppearanceSubpageScreens';
export { WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
