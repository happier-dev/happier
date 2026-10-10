import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { PromptAssetExportScreen } from '@/components/settings/prompts/assets/PromptAssetExportScreen';

export function ExportPromptDocPage() {
  const params = useLocalSearchParams<{
    id: string;
    assetTypeId?: string | string[];
    scope?: string | string[];
    workspacePath?: string | string[];
    serverId?: string | string[];
  }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!id) return null;
  return (
    <PromptAssetExportScreen
      artifactId={id}
      serverId={Array.isArray(params.serverId) ? params.serverId[0] : params.serverId}
      initialSelection={{
        assetTypeId: Array.isArray(params.assetTypeId) ? params.assetTypeId[0] : params.assetTypeId,
        scope: (Array.isArray(params.scope) ? params.scope[0] : params.scope) as 'project' | 'user' | undefined,
        workspacePath: Array.isArray(params.workspacePath) ? params.workspacePath[0] : params.workspacePath,
      }}
    />
  );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { ExportPromptDocPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ExportPromptDocPage} />; }
