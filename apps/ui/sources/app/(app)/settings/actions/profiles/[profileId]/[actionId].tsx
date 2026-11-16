import { ApprovalProfileActionSettingsView } from '@/components/settings/actions/ApprovalProfileSettingsRoutes';

export const WorkspaceRouteBody = ApprovalProfileActionSettingsView;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
