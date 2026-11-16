import { SessionSectionsSettingsView } from '@/components/settings/session/SessionSectionsSettingsView';

export { SessionSectionsSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionSectionsSettingsView} />; }
