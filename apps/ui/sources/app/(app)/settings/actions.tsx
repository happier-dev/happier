import { ActionsSettingsView } from '@/components/settings/actions/ActionsSettingsView';

export { ActionsSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ActionsSettingsView} />; }
