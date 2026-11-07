import { PluginPublishScreen } from '@/components/settings/plugins/development/PluginPublishScreen';

export const WorkspaceRouteBody = PluginPublishScreen;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
