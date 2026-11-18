import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { BulkSessionComposeRoute } from '@/components/sessions/bulkCompose/BulkSessionComposeScreen';

export { BulkSessionComposeRoute as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={BulkSessionComposeRoute} />; }
