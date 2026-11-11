import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { NewAppScreen } from '@/components/projects/starters/NewAppScreen';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

export { NewAppScreen as WorkspaceRouteBody };
export default function RouteEntry() {
  const params = useLocalSearchParams<{ starterId?: string }>();
  return <WorkspaceRouteEntry Body={() => <NewAppScreen starterId={params.starterId ?? null} />} />;
}
