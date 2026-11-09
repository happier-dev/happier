import { useLocalSearchParams } from 'expo-router';
import { BugReportComposerView } from '@/components/settings/bugReports/BugReportComposerView';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

export function WorkspaceRouteBody() {
  const params = useLocalSearchParams<{ sessionId?: string; serverId?: string; accountId?: string }>();
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  const serverId = typeof params.serverId === 'string' ? params.serverId.trim() : '';
  return <BugReportComposerView initialSessionTarget={sessionId && serverId ? {
    sessionId, serverId,
    // Empty means the launcher could not bind the selection to an Account.
    accountId: typeof params.accountId === 'string' ? params.accountId.trim() || null : null,
  } : null} />;
}
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
