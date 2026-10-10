import { SkillBundleEditorScreen } from '@/components/settings/prompts/skills/SkillBundleEditorScreen';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

export function NewSkillBundlePage() {
  const { serverId } = useLocalSearchParams<{ serverId?: string }>();
  return <SkillBundleEditorScreen artifactId={null} serverId={serverId} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { NewSkillBundlePage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewSkillBundlePage} />; }
