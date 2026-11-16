import { SessionProviderLimitsSettingsView } from '@/components/settings/session/SessionProviderLimitsSettingsView';

export { SessionProviderLimitsSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionProviderLimitsSettingsView} />; }
