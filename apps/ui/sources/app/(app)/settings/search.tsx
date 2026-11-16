import { SearchSettingsView } from '@/components/settings/search/SearchSettingsView';

export { SearchSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SearchSettingsView} />; }
