import { PluginWebhookAdministrationScreen } from '@/components/settings/plugins/webhooks/PluginWebhookAdministrationScreen';

export { PluginWebhookAdministrationScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PluginWebhookAdministrationScreen} />; }
