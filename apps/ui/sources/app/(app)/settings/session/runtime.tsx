import { SessionRuntimeSettingsView } from '@/components/settings/session/SessionRuntimeSettingsView';

export { SessionRuntimeSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionRuntimeSettingsView} />; }
