import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { CATALOG_AGENT_IDS } from '@/backends/types';
import type { CatalogAgentId } from '@/backends/types';

function isKnownAgentId(value: string): value is CatalogAgentId {
  return value !== 'customAcp' && (CATALOG_AGENT_IDS as readonly string[]).includes(value);
}

function readBuiltInCatalogAgentIdFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId | null {
  if (target?.kind !== 'builtInAgent') return null;
  return typeof target.agentId === 'string' && isKnownAgentId(target.agentId)
    ? (target.agentId as CatalogAgentId)
    : null;
}

function isMalformedBuiltInBackendTarget(target: BackendTargetRefV1 | undefined): boolean {
  return target?.kind === 'builtInAgent' && readBuiltInCatalogAgentIdFromBackendTarget(target) === null;
}

export function resolveDaemonCatalogAgentIdFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId | null {
  if (!target) {
    return null;
  }
  if (target?.kind === 'configuredAcpBackend') {
    return 'customAcp';
  }
  if (isMalformedBuiltInBackendTarget(target)) {
    return null;
  }
  return readBuiltInCatalogAgentIdFromBackendTarget(target);
}

export function resolveDaemonCliSubcommandFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId | 'acp-catalog' | null {
  if (!target) {
    return null;
  }
  if (target?.kind === 'configuredAcpBackend') {
    return 'acp-catalog';
  }
  if (isMalformedBuiltInBackendTarget(target)) {
    return null;
  }
  return readBuiltInCatalogAgentIdFromBackendTarget(target);
}
