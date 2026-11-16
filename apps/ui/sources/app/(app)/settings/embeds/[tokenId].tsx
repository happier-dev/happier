import { EmbedEditScreen } from '@/components/settings/embeds/EmbedDetailScreen';

export { EmbedEditScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={EmbedEditScreen} />; }
