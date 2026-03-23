import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { PromptAssetExportScreen } from '@/components/settings/prompts/assets/PromptAssetExportScreen';

export default function ExportPromptDocPage() {
  const params = useLocalSearchParams<{
    id: string;
    assetTypeId?: string | string[];
    machineId?: string | string[];
    scope?: string | string[];
    workspacePath?: string | string[];
  }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!id) return null;
  return (
    <PromptAssetExportScreen
      artifactId={id}
      initialSelection={{
        assetTypeId: Array.isArray(params.assetTypeId) ? params.assetTypeId[0] : params.assetTypeId,
        machineId: Array.isArray(params.machineId) ? params.machineId[0] : params.machineId,
        scope: (Array.isArray(params.scope) ? params.scope[0] : params.scope) as 'project' | 'user' | undefined,
        workspacePath: Array.isArray(params.workspacePath) ? params.workspacePath[0] : params.workspacePath,
      }}
    />
  );
}
