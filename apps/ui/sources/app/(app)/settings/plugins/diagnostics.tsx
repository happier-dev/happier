import { PluginDiagnosticsScreen } from '@/components/settings/plugins/diagnostics/PluginDiagnosticsScreen';

export { PluginDiagnosticsScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PluginDiagnosticsScreen} />; }
