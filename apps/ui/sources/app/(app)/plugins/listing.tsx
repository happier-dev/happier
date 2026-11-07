import { StoreListingRoute } from '@/components/store/StoreListing';

export const WorkspaceRouteBody = StoreListingRoute;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
