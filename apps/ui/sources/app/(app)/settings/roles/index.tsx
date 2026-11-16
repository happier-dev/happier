import { RoleSettingsIndex } from '@/components/settings/roles/RoleSettingsIndex';

export { RoleSettingsIndex as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={RoleSettingsIndex} />; }
