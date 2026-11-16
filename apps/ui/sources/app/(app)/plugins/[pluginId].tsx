import { PluginDetailRoute } from '@/components/settings/plugins/detail/PluginDetailRoute';

// A plugin's page opened from the main sidebar's Plugins page. Plugin-contributed app pages are
// the two-segment `plugins/[pluginId]/[localId]` routes beside it.
export { PluginDetailRoute as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PluginDetailRoute} />; }
