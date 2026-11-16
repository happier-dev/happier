import { ToolRenderingSettingsView } from '@/components/settings/session/ToolRenderingSettingsView';

export { ToolRenderingSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ToolRenderingSettingsView} />; }
