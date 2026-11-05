import { SecretsSettingsScreen as WorkspaceRouteBody } from '@/components/settings/secrets/SecretsSettingsScreen';
export { WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
