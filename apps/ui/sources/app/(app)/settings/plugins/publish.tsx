import { PluginPublishScreen } from '@/components/settings/plugins/development/PluginPublishScreen';

export { PluginPublishScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PluginPublishScreen} />; }
