import { PluginDetailRoute } from '@/components/settings/plugins/detail/PluginDetailRoute';

export { PluginDetailRoute as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PluginDetailRoute} />; }
