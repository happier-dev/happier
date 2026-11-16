import { ActionSettingsDetailView } from '@/components/settings/actions/ActionSettingsDetailView';

export { ActionSettingsDetailView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ActionSettingsDetailView} />; }
