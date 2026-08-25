import type { PluginAgentToolsDeliveryV2 } from '@happier-dev/protocol';

import { findCatalogEntry } from '@/agent/catalog/registry';

export type AgentToolsDelivery = PluginAgentToolsDeliveryV2 | 'unsupported';

/**
 * The resolved Agent catalog is the single current projection for bundled and
 * installed Agent facts. An absent declaration never inherits delivery from an
 * Agent id, runtime kind, or tool inventory.
 */
export function resolveAgentToolsDelivery(agentId: string): AgentToolsDelivery {
  return findCatalogEntry(agentId)?.toolDelivery ?? 'unsupported';
}
