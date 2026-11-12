import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { DiscussionRoute } from './[discussionId]';

export const NewDiscussionRoute = DiscussionRoute;

export { NewDiscussionRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewDiscussionRoute} />; }
