import { useDestinationParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { BulkSessionComposeRoute } from '@/components/sessions/bulkCompose/BulkSessionComposeScreen';

const selectComposeSeedId = (params: Readonly<{ dataId?: string | string[] }>) =>
    typeof params.dataId === 'string' ? params.dataId : undefined;

export function WorkspaceRouteBody() {
    const dataId = useDestinationParamsSelector(selectComposeSeedId);
    // A workspace can retain a tab across route changes. Each handoff gets its own draft and frozen targets.
    return <BulkSessionComposeRoute key={dataId} />;
}

export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
