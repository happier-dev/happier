import { ApprovalProfileSettingsView } from '@/components/settings/actions/ApprovalProfileSettingsRoutes';

export const WorkspaceRouteBody = ApprovalProfileSettingsView;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
