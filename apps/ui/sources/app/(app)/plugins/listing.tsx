import { StoreListingRoute } from '@/components/store/StoreListing';

export { StoreListingRoute as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={StoreListingRoute} />; }
