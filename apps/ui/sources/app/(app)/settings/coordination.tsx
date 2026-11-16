import { CoordinationSettingsView } from '@/components/settings/coordination/CoordinationSettingsView';

export { CoordinationSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={CoordinationSettingsView} />; }
