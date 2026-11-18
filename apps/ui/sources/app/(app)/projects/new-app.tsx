import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { NewAppScreen } from '@/components/projects/starters/NewAppScreen';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

export function WorkspaceRouteBody() {
  const params = useLocalSearchParams<{ starterId?: string; serverId?: string; machineId?: string }>();
  const machine = params.serverId && params.machineId ? { serverId: params.serverId, machineId: params.machineId } : null;
  const starterId = params.starterId ?? null;
  return <NewAppScreen key={JSON.stringify([starterId, machine?.serverId, machine?.machineId])} starterId={starterId} machine={machine} />;
}
export default function RouteEntry() {
  return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />;
}
