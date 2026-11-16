import { SessionComposerSettingsView } from '@/components/settings/session/SessionComposerSettingsView';

export { SessionComposerSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionComposerSettingsView} />; }
