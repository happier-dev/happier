import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { NewAppScreen } from '@/components/projects/starters/NewAppScreen';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

export { NewAppScreen as WorkspaceRouteBody };
export default function RouteEntry() {
  const params = useLocalSearchParams<{ starterId?: string; serverId?: string; machineId?: string }>();
  const machine = params.serverId && params.machineId ? { serverId: params.serverId, machineId: params.machineId } : null;
  return <WorkspaceRouteEntry Body={() => <NewAppScreen starterId={params.starterId ?? null} machine={machine} />} />;
}
