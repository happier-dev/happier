import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { SkillBundleSupportingFileEditorScreen } from '@/components/settings/prompts/skills/SkillBundleSupportingFileEditorScreen';

export function EditSkillSupportingFilePage() {
    const params = useLocalSearchParams<{ id: string; path?: string | string[]; serverId?: string }>();
    const id = params.id;
    const path = Array.isArray(params.path) ? params.path[0] : params.path ?? null;
    if (!id) return null;
    return <SkillBundleSupportingFileEditorScreen artifactId={id} path={path} serverId={params.serverId} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { EditSkillSupportingFilePage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={EditSkillSupportingFilePage} />; }
