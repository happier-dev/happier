import { TranscriptRenderingAdvancedSettingsView } from '@/components/settings/session/TranscriptRenderingAdvancedSettingsView';

export { TranscriptRenderingAdvancedSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={TranscriptRenderingAdvancedSettingsView} />; }
