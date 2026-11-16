import { SourceControlSettingsView } from '@/components/settings/sourceControl/SourceControlSettingsView';

export { SourceControlSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SourceControlSettingsView} />; }
