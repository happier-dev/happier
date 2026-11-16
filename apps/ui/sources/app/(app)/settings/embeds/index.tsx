import { EmbedsSettingsIndex } from '@/components/settings/embeds/EmbedsSettingsIndex';

export { EmbedsSettingsIndex as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={EmbedsSettingsIndex} />; }
