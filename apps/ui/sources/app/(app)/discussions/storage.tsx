import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { DiscussionStorageRoute } from '@/components/storage/discussion/DiscussionStorage';

/** A Discussion's Storage page (`?serverId=…&discussionId=…`): the phone's pushed page from the Discussion's "…". */
export { DiscussionStorageRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={DiscussionStorageRoute} />; }
