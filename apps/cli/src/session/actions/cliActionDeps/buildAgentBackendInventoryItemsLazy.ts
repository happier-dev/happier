import type { AgentBackendInventoryItem } from '@happier-dev/protocol';
import type { buildAgentBackendInventoryItems } from '@/session/actions/inventory/buildAgentBackendInventoryItems';

export async function buildAgentBackendInventoryItemsLazy(args: Parameters<typeof buildAgentBackendInventoryItems>[0]): Promise<AgentBackendInventoryItem[]> {
  const mod = await import('@/session/actions/inventory/buildAgentBackendInventoryItems');
  return await mod.buildAgentBackendInventoryItems(args);
}
