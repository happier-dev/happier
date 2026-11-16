import { TranscriptSettingsView } from '@/components/settings/session/TranscriptSettingsView';

export { TranscriptSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={TranscriptSettingsView} />; }
