import { PushNotificationTroubleshootingView } from '@/components/settings/notifications/PushNotificationTroubleshootingView';

export { PushNotificationTroubleshootingView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PushNotificationTroubleshootingView} />; }
