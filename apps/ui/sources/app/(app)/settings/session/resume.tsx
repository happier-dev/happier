import { SessionResumeSettingsView } from '@/components/settings/session/SessionResumeSettingsView';

export { SessionResumeSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionResumeSettingsView} />; }
