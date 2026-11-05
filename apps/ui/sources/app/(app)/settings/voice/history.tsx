import { VoiceHistoryScreen as WorkspaceRouteBody } from '@/voice/history/VoiceHistoryScreen';
export { WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
