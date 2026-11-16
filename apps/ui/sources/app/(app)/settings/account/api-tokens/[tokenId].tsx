import { ApiTokenDetailScreen } from '@/components/settings/apiTokens/ApiTokenDetailScreen';

export { ApiTokenDetailScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ApiTokenDetailScreen} />; }
