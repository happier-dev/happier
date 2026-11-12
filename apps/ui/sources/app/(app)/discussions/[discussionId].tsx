import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { DiscussionRouteScreen } from '@/components/discussions/DiscussionRouteScreen';

export function DiscussionRoute() {
    return <DiscussionRouteScreen kind="conversation" />;
}

export { DiscussionRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={DiscussionRoute} />; }
