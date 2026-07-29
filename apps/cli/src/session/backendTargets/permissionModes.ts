import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { AGENTS } from '@/agent/catalog/registry';
import {
  isCatalogAgentId,
} from '@/agent/catalog/resolution';

export function normalizeSessionControlPermissionModeForBackendTarget(params: Readonly<{
  backendTarget?: BackendTargetRefV2;
  permissionMode: string;
}>): string {
  const builtInAgentId = params.backendTarget?.sourceKind === 'built_in'
    ? params.backendTarget.backendId
    : null;
  if (!builtInAgentId || !isCatalogAgentId(builtInAgentId)) {
    return params.permissionMode;
  }

  const entry = AGENTS[builtInAgentId];
  if (!entry?.normalizeSessionControlPermissionMode) {
    return params.permissionMode;
  }
  return entry.normalizeSessionControlPermissionMode(params.permissionMode);
}
