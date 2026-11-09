import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { StoreKindSurface } from '@/components/store/StoreKindSurface';

export function WorkspaceRouteBody() {
    return <StoreKindSurface kind="bot" mode="browse" presented={useIsFocused()} />;
}

export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
