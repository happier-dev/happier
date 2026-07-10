import type { AgentId } from '@happier-dev/agents';

import { AGENTS } from '@/agent/catalog/registry';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import type { ProviderRuntimeLocalHandoffMetadataBuilder } from '@/agent/catalog/types';

export function buildRuntimeLocalHandoffMetadataForAgent(
  agentId: AgentId | null | undefined,
  params: Parameters<ProviderRuntimeLocalHandoffMetadataBuilder>[0],
): ReturnType<ProviderRuntimeLocalHandoffMetadataBuilder> | null {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return entry?.buildRuntimeLocalHandoffMetadata?.(params) ?? null;
}
