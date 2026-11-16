import { PublicProfileEditorScreen } from '@/components/settings/account/publicProfile/PublicProfileEditorScreen';

export { PublicProfileEditorScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PublicProfileEditorScreen} />; }
