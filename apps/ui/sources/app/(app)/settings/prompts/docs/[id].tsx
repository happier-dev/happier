import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { PromptDocEditorScreen } from '@/components/settings/prompts/docs/PromptDocEditorScreen';

export function EditPromptDocPage() {
  const { id, serverId } = useLocalSearchParams<{ id: string; serverId?: string }>();
  if (!id) return null;
  return <PromptDocEditorScreen artifactId={id} serverId={serverId} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { EditPromptDocPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={EditPromptDocPage} />; }
