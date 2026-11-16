import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { DiscussionRoute } from './[discussionId]';

export { DiscussionRoute as NewDiscussionRoute, DiscussionRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={DiscussionRoute} />; }
