import SessionSectionsSettingsView from '@/components/settings/session/SessionSectionsSettingsView';

export const WorkspaceRouteBody = SessionSectionsSettingsView;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
