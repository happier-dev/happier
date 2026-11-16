import { EmbedCreateScreen } from '@/components/settings/embeds/EmbedDetailScreen';

export { EmbedCreateScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={EmbedCreateScreen} />; }
