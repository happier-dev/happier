import { PluginSettingsHomeScreen } from '@/components/settings/plugins/PluginSettingsHomeScreen';

export { PluginSettingsHomeScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PluginSettingsHomeScreen} />; }
