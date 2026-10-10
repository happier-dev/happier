import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { SkillBundleEditorScreen } from '@/components/settings/prompts/skills/SkillBundleEditorScreen';

export function EditSkillBundlePage() {
  const { id, serverId } = useLocalSearchParams<{ id: string; serverId?: string }>();
  if (!id) return null;
  return <SkillBundleEditorScreen artifactId={id} serverId={serverId} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { EditSkillBundlePage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={EditSkillBundlePage} />; }
