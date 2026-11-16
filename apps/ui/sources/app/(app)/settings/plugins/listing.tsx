import { PluginListingRoute } from '@/components/settings/plugins/listing/PluginListingRoute';

export { PluginListingRoute as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PluginListingRoute} />; }
