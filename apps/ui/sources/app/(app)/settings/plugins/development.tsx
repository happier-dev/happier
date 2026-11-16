import { PluginDevelopmentScreen } from '@/components/settings/plugins/development/PluginDevelopmentScreen';

export { PluginDevelopmentScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PluginDevelopmentScreen} />; }
