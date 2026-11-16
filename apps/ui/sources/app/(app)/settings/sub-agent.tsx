import { SubAgentSettingsView } from '@/components/settings/subAgent/SubAgentSettingsView';

export { SubAgentSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SubAgentSettingsView} />; }
