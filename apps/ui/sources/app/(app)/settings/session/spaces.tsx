import CollectionSpacesSettingsView from '@/components/settings/session/CollectionSpacesSettingsView';

export const WorkspaceRouteBody = CollectionSpacesSettingsView;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
