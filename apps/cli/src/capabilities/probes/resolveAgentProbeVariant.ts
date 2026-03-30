import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveConfiguredAcpProbeCacheVariant } from './configuredAcpProbeCacheVariant';

export function resolveAgentProbeVariant(params: Readonly<{
  agentId: CatalogAgentId;
  backendTarget?: BackendTargetRefV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>): string {
  const configuredAcpVariant = resolveConfiguredAcpProbeCacheVariant({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
    accountSettings: params.accountSettings,
  });
  if (configuredAcpVariant) return configuredAcpVariant;

  const entry = AGENTS[params.agentId];
  const entryVariant = entry?.resolveModelsProbeVariant?.({
    backendTarget: params.backendTarget,
    accountSettings: params.accountSettings ?? null,
  }) ?? null;
  return entryVariant ?? `${params.agentId}:default`;
}
