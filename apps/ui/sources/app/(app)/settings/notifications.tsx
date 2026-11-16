import { NotificationsSettingsView } from '@/components/settings/notifications/NotificationsSettingsView';

export { NotificationsSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NotificationsSettingsView} />; }
