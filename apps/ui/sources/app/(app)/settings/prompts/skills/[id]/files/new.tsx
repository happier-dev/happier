import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { SkillBundleSupportingFileEditorScreen } from '@/components/settings/prompts/skills/SkillBundleSupportingFileEditorScreen';

export function NewSkillSupportingFilePage() {
    const { id, serverId } = useLocalSearchParams<{ id: string; serverId?: string }>();
    if (!id) return null;
    return <SkillBundleSupportingFileEditorScreen artifactId={id} path={null} serverId={serverId} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { NewSkillSupportingFilePage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewSkillSupportingFilePage} />; }
