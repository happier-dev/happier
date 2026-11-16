import { PluginSourcesScreen } from '@/components/settings/plugins/PluginSourcesScreen';

export { PluginSourcesScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PluginSourcesScreen} />; }
