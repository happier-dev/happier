import { SessionHandoffSettingsView } from '@/components/settings/session/SessionHandoffSettingsView';

export { SessionHandoffSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionHandoffSettingsView} />; }
