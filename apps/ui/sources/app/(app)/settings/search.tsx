import { SearchSettingsView } from '@/components/settings/search/SearchSettingsView';

export const WorkspaceRouteBody = SearchSettingsView;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
