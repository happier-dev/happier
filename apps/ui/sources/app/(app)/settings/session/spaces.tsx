import { CollectionSpacesSettingsView } from '@/components/settings/session/CollectionSpacesSettingsView';

export { CollectionSpacesSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={CollectionSpacesSettingsView} />; }
